import { useEffect, useRef, useState } from "react";

interface EmailBodyProps {
  bodyHtml?: string | null;
  bodyText?: string | null;
  snippet?: string | null;
}

/**
 * Renders an email's content. Gmail messages are often HTML-only
 * (marketing emails, images, formatted layouts) — bodyText can be
 * empty even though bodyHtml has the real content. This prefers
 * bodyHtml when present, rendering it inside a sandboxed iframe so
 * sender-controlled markup/styles/scripts can't touch the rest of
 * the app. Falls back to plain text, then snippet, if no HTML body
 * exists (e.g. manually pasted emails).
 */
export function EmailBody({ bodyHtml, bodyText, snippet }: EmailBodyProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);

  const hasHtml = !!bodyHtml && bodyHtml.trim().length > 0;

  useEffect(() => {
    if (!hasHtml || !iframeRef.current) return;
    const iframe = iframeRef.current;

    // Wrap with a base style so emails without their own styling
    // still get a readable font/size, and force images/tables to
    // never overflow the panel width.
    const doc = `<!DOCTYPE html><html><head><base target="_blank"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; color: #111; word-wrap: break-word; }
      img { max-width: 100%; height: auto; }
      table { max-width: 100%; }
      a { color: #2563eb; }
    </style></head><body>${bodyHtml}</body></html>`;

    iframe.srcdoc = doc;

    const resize = () => {
      try {
        const doc = iframe.contentDocument;
        if (doc?.body) {
          setHeight(Math.min(Math.max(doc.body.scrollHeight + 20, 100), 2000));
        }
      } catch {
        // Cross-origin or not-yet-loaded; ignore.
      }
    };

    iframe.onload = resize;
    // A second pass after images load asynchronously.
    const t = setTimeout(resize, 500);
    return () => clearTimeout(t);
  }, [bodyHtml, hasHtml]);

  if (hasHtml) {
    return (
      <iframe
        ref={iframeRef}
        title="Email content"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        style={{ width: "100%", height, border: "none", display: "block" }}
      />
    );
  }

  return (
    <pre className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed">
      {bodyText || snippet || "(No content)"}
    </pre>
  );
}
