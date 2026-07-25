/**
 * Deterministic promotional / bulk-mail detection.
 *
 * Why this exists: promotional mail was being routed purely by the LLM
 * categorizer (aiPipeline.categorizeEmail). That call is fire-and-forget and
 * fails silently on rate limits / timeouts, and even when it runs it can
 * mislabel. A missed label means the email has no "Spam/Promotional" category,
 * so the employee-app shows it in "All" and never in "Promotions" (the All
 * view only hides emails already labeled exactly "Spam/Promotional").
 *
 * The fix is to decide "is this promotional?" from hard signals that don't
 * depend on an LLM, and apply the label directly. These signals are the same
 * ones every real mail client uses:
 *
 *   1. Gmail's own category — labelIds contains CATEGORY_PROMOTIONS or SPAM.
 *      This is authoritative for Gmail-connected accounts and free.
 *   2. A List-Unsubscribe header (RFC 2369). Marketing / newsletter / bulk
 *      senders set this; genuine one-to-one mail almost never does.
 *   3. Precedence: bulk | list | junk  (and Auto-Submitted: auto-generated).
 *   4. An "unsubscribe" link/word in the body — the fallback used when the
 *      raw headers weren't retained (e.g. backfilling already-stored rows,
 *      which only kept subject/from/body, not the original headers).
 *
 * Any one of these is enough. The LLM categorizer still handles everything
 * that isn't caught here (Support Request vs Billing vs Sales, etc.).
 */

/** The canonical category label the rest of the app filters on. */
export const PROMOTIONAL_LABEL = "Spam/Promotional";

export interface PromoSignals {
  /** Gmail message.labelIds, when syncing a Gmail (OAuth) account. */
  gmailLabelIds?: readonly string[] | null;
  /** Raw List-Unsubscribe header value, if present. */
  listUnsubscribe?: string | null;
  /** Raw Precedence header value, if present. */
  precedence?: string | null;
  /** Raw Auto-Submitted header value, if present. */
  autoSubmitted?: string | null;
  /** Plain-text body (used for the "unsubscribe" fallback). */
  bodyText?: string | null;
  /** HTML body (used for the "unsubscribe" fallback). */
  bodyHtml?: string | null;
}

const GMAIL_PROMO_LABELS = new Set(["CATEGORY_PROMOTIONS", "SPAM"]);
const BULK_PRECEDENCE = new Set(["bulk", "list", "junk"]);
// "unsubscribe" as a whole word, in body text or an href — the near-universal
// footer of marketing/newsletter mail, and very rare in real 1:1 email.
const UNSUBSCRIBE_RE = /unsubscribe/i;

/**
 * Returns true when an email should be treated as promotional/bulk based on
 * deterministic signals only (no LLM). Designed to be safe to over-trust: the
 * checks fire on bulk-mail infrastructure markers, not on content topic.
 */
export function isPromotionalEmail(signals: PromoSignals): boolean {
  // 1) Gmail's own classification — authoritative when available.
  if (signals.gmailLabelIds) {
    for (const id of signals.gmailLabelIds) {
      if (GMAIL_PROMO_LABELS.has(id)) return true;
    }
  }

  // 2) List-Unsubscribe header present and non-empty.
  if (signals.listUnsubscribe && signals.listUnsubscribe.trim().length > 0) return true;

  // 3) Precedence: bulk/list/junk.
  if (signals.precedence && BULK_PRECEDENCE.has(signals.precedence.trim().toLowerCase())) return true;

  // 3b) Auto-Submitted: anything other than "no" means machine-generated bulk.
  if (signals.autoSubmitted) {
    const v = signals.autoSubmitted.trim().toLowerCase();
    if (v && v !== "no") return true;
  }

  // 4) Fallback for rows without retained headers: an unsubscribe link/word.
  if (signals.bodyHtml && UNSUBSCRIBE_RE.test(signals.bodyHtml)) return true;
  if (signals.bodyText && UNSUBSCRIBE_RE.test(signals.bodyText)) return true;

  return false;
}

/**
 * Normalizes a header lookup that might come from a plain lowercased-key
 * object (Gmail path) or a mailparser Headers Map (IMAP path) into a plain
 * string, so callers on either side can build PromoSignals uniformly.
 */
export function headerValue(
  headers: Record<string, unknown> | Map<string, unknown> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const key = name.toLowerCase();
  const raw = headers instanceof Map ? headers.get(key) : headers[key];
  if (raw == null) return null;
  if (typeof raw === "string") return raw;
  // mailparser sometimes yields structured objects (e.g. { value, params }).
  if (typeof raw === "object" && "value" in (raw as any)) {
    const v = (raw as any).value;
    return typeof v === "string" ? v : String(v);
  }
  return String(raw);
}
