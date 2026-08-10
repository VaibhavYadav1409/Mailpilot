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
// Starting height for the HTML iframe before its content is measured. Also
// the floor it's never allowed to drop below, so a message never renders as a
// cramped letterbox while images are still loading.
const MIN_BODY_HEIGHT = 600;
const MAX_BODY_HEIGHT = 20_000;

export function EmailBody({ bodyHtml, bodyText, snippet }: EmailBodyProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_BODY_HEIGHT);

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
        if (!doc?.body) return;
        // scrollHeight on <body> under-reports when children are floated or
        // absolutely positioned (common in templated marketing mail), so take
        // the largest of the usual suspects rather than trusting one.
        const measured = Math.max(
          doc.body.scrollHeight,
          doc.body.offsetHeight,
          doc.documentElement?.scrollHeight ?? 0,
          doc.documentElement?.offsetHeight ?? 0
        );
        if (measured > 0) {
          setHeight(Math.min(Math.max(measured + 32, MIN_BODY_HEIGHT), MAX_BODY_HEIGHT));
        }
      } catch {
        // Not yet loaded; the retries below cover it.
      }
    };

    iframe.onload = resize;

    // Images, webfonts and remote CSS all settle after onload and each can
    // change the document height, so re-measure a few times instead of once.
    const timers = [100, 400, 1000, 2500].map((ms) => setTimeout(resize, ms));

    // Catches later reflows (lazy images, slow remote assets) that fixed
    // timers would miss. Guarded because ResizeObserver needs a live
    // same-origin document.
    let observer: ResizeObserver | undefined;
    try {
      const body = iframe.contentDocument?.body;
      if (body && typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(resize);
        observer.observe(body);
      }
    } catch {
      // Fall back to the timers above.
    }

    return () => {
      timers.forEach(clearTimeout);
      observer?.disconnect();
    };
  }, [bodyHtml, hasHtml]);

  if (hasHtml) {
    return (
      <iframe
        ref={iframeRef}
        title="Email content"
        // `allow-same-origin` is required for the height measurement above —
        // without it `contentDocument` is inaccessible, every resize attempt
        // threw, and the frame stayed pinned at its initial height, so long
        // emails rendered in a short scrolling box instead of laying out in
        // full.
        //
        // This is safe specifically because `allow-scripts` is NOT set:
        // sender markup still cannot execute any JavaScript, so it has no way
        // to reach the parent document. (The combination to avoid is
        // allow-scripts together with allow-same-origin, which would let
        // sender-controlled script escape the sandbox entirely.)
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
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
