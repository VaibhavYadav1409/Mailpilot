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

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const { messages, model = DEFAULT_MODEL, responseFormat } = params;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY env var is not configured");

  const payload: Record<string, unknown> = { model, messages };
  if (responseFormat) payload.response_format = responseFormat;

  // Without a timeout, a stalled connection to Groq hangs this fetch call
  // forever with no error and no log line — which is especially painful for
  // callers that run several of these concurrently (e.g. the categorization
  // backfill script), since one stuck request blocks the whole batch it's
  // part of. 30s is generous for a single chat completion; a real response
  // normally comes back in a few seconds.
  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error: ${response.status} ${response.statusText} – ${err}`);
  }
  return (await response.json()) as InvokeResult;
}
