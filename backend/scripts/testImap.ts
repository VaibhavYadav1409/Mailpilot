/**
 * Standalone IMAP login tester.
 *
 * The "AUTHENTICATE failed" a mail server returns is the same regardless of
 * WHY it refused — wrong password, wrong username format, IMAP disabled for
 * the mailbox, or wrong port. This tries the plausible combinations in one
 * run so you can see which (if any) the server accepts, instead of guessing
 * one at a time through the UI.
 *
 * Usage (from backend/):
 *   npx tsx scripts/testImap.ts demat@farsightshares.com "thepassword"
 *   npx tsx scripts/testImap.ts demat@farsightshares.com "thepassword" webmail.nfcmail.io
 *
 * Nothing is written to the database and no account is connected — this only
 * opens a connection, attempts login, and disconnects.
 */
import { ImapFlow } from "imapflow";

const [, , email, password, hostArg] = process.argv;

if (!email || !password) {
  console.error('Usage: npx tsx scripts/testImap.ts <email> "<password>" [host]');
  process.exit(1);
}

const domain = email.split("@")[1];
const localPart = email.split("@")[0];
const host = hostArg || (domain === "farsightshares.com" ? "webmail.nfcmail.io" : `imap.${domain}`);

interface Attempt {
  label: string;
  user: string;
  port: number;
  secure: boolean;
}

// 993/secure is implicit TLS; 143/insecure upgrades via STARTTLS. Hosts that
// disable one often still allow the other.
const attempts: Attempt[] = [
  { label: "full email @ 993 (TLS)", user: email, port: 993, secure: true },
  { label: "local part @ 993 (TLS)", user: localPart, port: 993, secure: true },
  { label: "full email @ 143 (STARTTLS)", user: email, port: 143, secure: false },
  { label: "local part @ 143 (STARTTLS)", user: localPart, port: 143, secure: false },
];

async function tryOne(a: Attempt): Promise<boolean> {
  const client = new ImapFlow({
    host,
    port: a.port,
    secure: a.secure,
    auth: { user: a.user, pass: password },
    logger: false,
    // Don't let one dead combination stall the whole run.
    socketTimeout: 20_000,
  });

  try {
    await client.connect();
    // Prove the session is genuinely usable, not just authenticated.
    const box = await client.mailboxOpen("INBOX");
    console.log(`  ✅ SUCCESS — ${a.label}  (INBOX has ${box.exists} messages)`);
    await client.logout();
    return true;
  } catch (err: any) {
    const detail = err?.responseText || err?.response || err?.message || String(err);
    console.log(`  ❌ ${a.label} — ${detail}`);
    try {
      client.close();
    } catch {
      /* already closed */
    }
    return false;
  }
}

async function main() {
  console.log(`\nTesting IMAP login for ${email}`);
  console.log(`Host: ${host}\n`);

  let anySuccess = false;
  for (const a of attempts) {
    // Sequential on purpose: some servers throttle or temporarily block after
    // several rapid failed logins, which would poison later attempts.
    if (await tryOne(a)) anySuccess = true;
  }

  console.log("");
  if (anySuccess) {
    console.log("At least one combination worked — use those exact settings in the app's Advanced Settings.");
  } else {
    console.log("Every combination was refused.");
    console.log("Since the password works in webmail, that points to IMAP being disabled for this");
    console.log("mailbox, or the host requiring an app-specific password. Worth asking whoever");
    console.log("administers nfcmail.io to confirm IMAP access is enabled for this account.");
  }
}

main().catch((e) => {
  console.error("Tester crashed:", e);
  process.exit(1);
});
