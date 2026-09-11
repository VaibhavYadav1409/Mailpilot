/**
 * Deterministic "this sender never needs a reply" list.
 *
 * Why this exists alongside promoDetector.ts: some senders are unambiguously
 * automated (bank alerts, depository notices, e-voting / e-statement robots)
 * but carry none of the bulk-mail markers promoDetector looks for — no
 * List-Unsubscribe, no Precedence: bulk, no Gmail promo label, no unsubscribe
 * footer. They therefore fall through to the LLM, which can classify them as
 * NEEDS_REPLY and park them in the employee's Unreplied list forever.
 *
 * A hard-coded address list is strictly more reliable than the model for these
 * and costs nothing. Matching is exact-address (case-insensitive), plus an
 * optional wildcard form ("*@domain.tld") for whole automated domains.
 *
 * Extending without a redeploy: set NO_REPLY_SENDERS in the environment to a
 * comma-separated list of addresses or *@domain patterns; entries are merged
 * with the built-in list below.
 */

/** Built-in addresses that never warrant a reply. Keep lowercase. */
export const NO_REPLY_SENDERS: readonly string[] = [
  "alert@icici.bank.in",
  "eazypay@icici.bank.in",
  "noreply@nsdl.com",
  "epass@nsdl.com",
  "evoting@nsdl.com",
  "nsdl@nsdl.com",
];

/**
 * Generic local-parts that are automated by convention, whatever the domain.
 * Matched against the part before "@" as a whole token (so "noreply",
 * "no-reply", "no_reply", "donotreply" all hit, but "replyto@" does not).
 */
const AUTOMATED_LOCAL_PARTS = [
  /^no[-_.]?reply$/,
  /^do[-_.]?not[-_.]?reply$/,
  /^noreply[-_.]/,
];

function parseEnvList(): string[] {
  const raw = process.env.NO_REPLY_SENDERS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Exact addresses, lowercased. */
let exactCache: Set<string> | null = null;
/** Domains from "*@domain.tld" patterns, lowercased, without the "@". */
let domainCache: Set<string> | null = null;

function buildCaches() {
  const exact = new Set<string>();
  const domains = new Set<string>();
  for (const entry of [...NO_REPLY_SENDERS, ...parseEnvList()]) {
    const e = entry.trim().toLowerCase();
    if (!e) continue;
    if (e.startsWith("*@")) domains.add(e.slice(2));
    else if (e.startsWith("@")) domains.add(e.slice(1));
    else exact.add(e);
  }
  exactCache = exact;
  domainCache = domains;
}

/** Test hook / used when NO_REPLY_SENDERS is changed at runtime. */
export function resetNoReplySenderCache(): void {
  exactCache = null;
  domainCache = null;
}

/**
 * Normalizes a From value that may be a bare address or a display-name form
 * ("NSDL Alerts <noreply@nsdl.com>") down to the bare lowercase address.
 */
export function normalizeAddress(from: string | null | undefined): string | null {
  if (!from) return null;
  const angle = from.match(/<([^>]+)>/);
  const addr = (angle ? angle[1] : from).trim().toLowerCase();
  return addr.includes("@") ? addr : null;
}

/**
 * True when mail from this address never warrants a reply. Safe to call with
 * a raw From header value.
 */
export function isNoReplySender(from: string | null | undefined): boolean {
  const addr = normalizeAddress(from);
  if (!addr) return false;
  if (!exactCache || !domainCache) buildCaches();
  if (exactCache!.has(addr)) return true;

  const at = addr.lastIndexOf("@");
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (domainCache!.has(domain)) return true;

  return AUTOMATED_LOCAL_PARTS.some((re) => re.test(local));
}
