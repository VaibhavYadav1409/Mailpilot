// Reused from mailpilot-client-updated/server/_core/llm.ts almost unchanged —
// the Groq OpenAI-compatible endpoint call worked fine. Difference: the old
// version read the API key from a per-user Settings row (single-user app);
// here it's a company-wide credential. If a future requirement needs
// per-company Groq keys (e.g. companies bringing their own billing), extend
// CompanySettings with a groqApiKey field and check it before the env
// fallback, same pattern as the old code used for Google credentials.

export type Role = "system" | "user" | "assistant";
export type Message = { role: Role; content: string };
export type InvokeParams = {
  messages: Message[];
  model?: string;
  responseFormat?: { type: "json_object" } | { type: "text" };
};
export type InvokeResult = {
  choices: Array<{
    message: { role: Role; content: string };
    finish_reason: string | null;
  }>;
};

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// Groq's free tier enforces BOTH per-minute and per-DAY limits. A sync fires
// many categorize/priority calls, so bursts hit HTTP 429. We retry the
// short/transient ones, but with two hard safety rules learned the hard way:
//
//  1. NEVER sleep for a long time inside a call. When the *daily* quota is
//     exhausted, Groq's Retry-After can be tens of minutes. Honoring that
//     literally meant every in-flight AI call slept for ~45min while still
//     holding its email body in memory — hundreds of them piled up and OOM-
//     killed the 512MB Render instance. Waits are capped at MAX_WAIT_MS; a
//     longer required wait means "give up now", not "block".
//
//  2. Circuit breaker. The first time we see a rate-limit that asks us to
//     wait beyond the cap, we record a cooldown and every subsequent call
//     fails INSTANTLY (no fetch, no sleep, no memory held) until it passes.
//     This stops a sync from queuing hundreds of doomed, memory-holding calls
//     against an already-exhausted quota. Categorization is best-effort — a
//     skipped email is retried on the next sync once the quota resets, and
//     promotional routing no longer depends on the LLM at all.
const MAX_RETRIES = 3; // total attempts = MAX_RETRIES + 1
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 8_000;
// Longest we're ever willing to block a single call. Anything beyond this
// trips the circuit breaker and fails fast instead of sleeping.
const MAX_WAIT_MS = 10_000;
// How long to stay "cooling down" when we can't derive a real Retry-After.
const DEFAULT_COOLDOWN_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Circuit-breaker state, shared across all callers in this process.
let groqCooldownUntil = 0;

/** True while Groq is in a rate-limit cooldown — callers can check this to skip firing AI work entirely. */
export function isGroqCoolingDown(): boolean {
  return Date.now() < groqCooldownUntil;
}

/** Retry-After may be seconds (a number) or an HTTP date; returns ms to wait, or null if unparseable. */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

/** Exponential backoff with jitter: ~1s, 2s, 4s, 8s (capped), + up to 500ms jitter. */
function backoffMs(attempt: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * 500);
}

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const { messages, model = DEFAULT_MODEL, responseFormat } = params;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY env var is not configured");

  // Fail fast (no fetch, no memory held) while the breaker is open.
  if (isGroqCoolingDown()) {
    throw new Error("Groq rate-limit cooldown active; skipping call");
  }

  const payload: Record<string, unknown> = { model, messages };
  if (responseFormat) payload.response_format = responseFormat;

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      // 30s timeout so a stalled connection fails (and gets retried) instead of
      // hanging this call — and the batch it's part of — forever.
      response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      // Network failure or timeout (AbortError/TimeoutError) — retryable.
      lastError = e;
      if (attempt === MAX_RETRIES) throw e;
      const waitMs = backoffMs(attempt);
      console.warn(`[llm] network/timeout calling Groq (attempt ${attempt + 1}/${MAX_RETRIES + 1}); retrying in ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    if (response.ok) return (await response.json()) as InvokeResult;

    const body = await response.text().catch(() => "");

    // 429 (rate limit) and 5xx (transient upstream) are retryable — but only
    // for SHORT waits. A long required wait means the quota is exhausted:
    // trip the breaker and fail fast so we don't sleep holding memory.
    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`Groq API error: ${response.status} ${response.statusText} – ${body}`);
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const waitMs = retryAfterMs ?? backoffMs(attempt);

      if (waitMs > MAX_WAIT_MS || attempt === MAX_RETRIES) {
        // Open the circuit breaker for the requested cooldown (capped-log
        // friendly) so subsequent calls fail instantly instead of piling up.
        if (response.status === 429) {
          groqCooldownUntil = Date.now() + (retryAfterMs ?? DEFAULT_COOLDOWN_MS);
          console.warn(
            `[llm] Groq rate limit exhausted; cooling down for ${Math.round((groqCooldownUntil - Date.now()) / 1000)}s and skipping AI calls until then`,
          );
        }
        throw lastError;
      }

      console.warn(`[llm] Groq ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}); retrying in ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    // Other 4xx (e.g. 401 bad key, 400 malformed request) — not retryable.
    throw new Error(`Groq API error: ${response.status} ${response.statusText} – ${body}`);
  }

  throw lastError ?? new Error("Groq API error: exhausted retries");
}
