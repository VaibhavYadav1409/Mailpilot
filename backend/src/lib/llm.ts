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

// Groq's free tier enforces per-minute request/token limits. A sync of a busy
// mailbox fires hundreds of categorize/priority calls, so bursts routinely hit
// HTTP 429. The old code threw on the first 429 and the caller (fire-and-forget
// in emailSync.ts) only logged it — so rate-limited emails were left
// permanently uncategorized. We now retry 429s (and transient 5xx / network /
// timeout failures) with exponential backoff, honoring the Retry-After header
// Groq returns, so those calls succeed on a later attempt instead of dropping.
const MAX_RETRIES = 5; // total attempts = MAX_RETRIES + 1
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry-After may be seconds (a number) or an HTTP date; returns ms to wait, or null if unparseable. */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

/** Exponential backoff with jitter: ~1s, 2s, 4s, 8s, 16s (capped), + up to 500ms jitter. */
function backoffMs(attempt: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * 500);
}

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const { messages, model = DEFAULT_MODEL, responseFormat } = params;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY env var is not configured");

  const payload: Record<string, unknown> = { model, messages };
  if (responseFormat) payload.response_format = responseFormat;

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      // 30s timeout so a stalled connection fails (and now gets retried)
      // instead of hanging this call — and the batch it's part of — forever.
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

    // 429 (rate limit) and 5xx (transient upstream) are retryable.
    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`Groq API error: ${response.status} ${response.statusText} – ${body}`);
      if (attempt === MAX_RETRIES) throw lastError;
      const waitMs = parseRetryAfterMs(response.headers.get("retry-after")) ?? backoffMs(attempt);
      console.warn(`[llm] Groq ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}); retrying in ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    // Other 4xx (e.g. 401 bad key, 400 malformed request) — not retryable.
    throw new Error(`Groq API error: ${response.status} ${response.statusText} – ${body}`);
  }

  throw lastError ?? new Error("Groq API error: exhausted retries");
}
