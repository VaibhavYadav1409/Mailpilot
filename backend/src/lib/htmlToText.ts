/**
 * Minimal, dependency-free HTML → plain text conversion.
 *
 * Why this exists: a large share of real-world mail (marketing, invoices,
 * most SaaS notification emails, anything sent from a template) is
 * HTML-only — it never had a text/plain MIME part to begin with. Both sync
 * paths (Gmail API in emailSync.ts, IMAP in imapSync.ts) previously only
 * ever looked at text/plain, so those messages landed in the database with
 * an empty bodyText. Two things fed on that empty string: the reader pane
 * (falls back to the 160-char snippet, so "the email" was effectively just
 * its own preview line) and the AI pipeline (categorizeEmail/
 * scoreEmailPriority/summarizeEmailThread/suggestEmailReply all receive
 * bodyText as their only signal — an empty body reliably produces a
 * generic/wrong category and a useless summary, no matter how good the
 * model is).
 *
 * This isn't a goal of producing beautiful text — it exists purely so
 * "was there a text/plain part" stops being the deciding factor in whether
 * an email is readable and classifiable. Full HTML is still preserved
 * separately (see Email.bodyHtml) for actually rendering the message.
 */
export function htmlToPlainText(html: string): string {
  let text = html;

  // Drop non-content elements entirely (tags + contents).
  text = text.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Turn block-ish boundaries into newlines before stripping tags, so
  // paragraphs/list items/table rows don't all run together on one line.
  text = text.replace(/<(br|br\/|br \/)>/gi, "\n");
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "- ");

  // Strip all remaining tags.
  text = text.replace(/<[^>]+>/g, "");

  // Decode the handful of entities that actually show up in real mail.
  const entities: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
  };
  text = text.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, (m) => entities[m]);
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

  // Collapse the whitespace the tag-stripping above tends to leave behind.
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}
