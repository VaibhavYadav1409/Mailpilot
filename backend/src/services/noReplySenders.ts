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

/**
 * Address PAIRS whose mail to each other never needs a reply, in either
 * direction. Distinct from the sender list above: these are real mailboxes
 * that do need replies in general — it's only the traffic between the two
 * that's internal housekeeping. Matching therefore looks at the recipients
 * too, so mail from one of them to anyone else is untouched.
 *
 * Extend via NO_REPLY_PAIRS: "a@x.com:b@x.com,c@x.com:d@x.com".
 */
export const NO_REPLY_PAIRS: readonly (readonly [string, string])[] = [
  ["global@farsightshares.com", "newaccount@farsightshares.com"],
];

function parsePairsEnv(): [string, string][] {
  const raw = process.env.NO_REPLY_PAIRS;
  if (!raw) return [];
  const pairs: [string, string][] = [];
  for (const entry of raw.split(",")) {
    const [a, b] = entry.split(":").map((x) => x.trim().toLowerCase());
    if (a && b) pairs.push([a, b]);
  }
  return pairs;
}

/**
 * True when this is mail between the two halves of a configured pair, in
 * either direction. `recipients` should be every address the message went to
 * (To + Cc, plus the mailbox owner — an address can be a Bcc'd owner and so
 * appear in neither header).
 */
export function isNoReplyPair(
  from: string | null | undefined,
  recipients: readonly (string | null | undefined)[],
): boolean {
  const sender = normalizeAddress(from);
  if (!sender) return false;

  const to = new Set(
    recipients.map((r) => normalizeAddress(r)).filter((r): r is string => r !== null),
  );
  if (to.size === 0) return false;

  for (const [a, b] of [...NO_REPLY_PAIRS, ...parsePairsEnv()]) {
    const first = a.toLowerCase();
    const second = b.toLowerCase();
    if (sender === first && to.has(second)) return true;
    if (sender === second && to.has(first)) return true;
  }
  return false;
}

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
