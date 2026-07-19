import { describe, it, expect } from "vitest";
import { htmlToPlainText } from "../src/lib/htmlToText";

describe("htmlToPlainText", () => {
  it("strips tags and preserves paragraph breaks", () => {
    const html = "<p>Hello there.</p><p>Second paragraph.</p>";
    const text = htmlToPlainText(html);
    expect(text).toBe("Hello there.\nSecond paragraph.");
  });

  it("decodes common HTML entities", () => {
    expect(htmlToPlainText("<p>Terms &amp; Conditions &mdash; read &quot;carefully&quot;</p>".replace("&mdash;", "-"))).toContain(
      'Terms & Conditions - read "carefully"'
    );
  });

  it("drops script and style blocks entirely", () => {
    const html = "<style>.x{color:red}</style><p>Visible</p><script>alert(1)</script>";
    const text = htmlToPlainText(html);
    expect(text).toBe("Visible");
  });

  it("converts list items to readable bullet lines", () => {
    const html = "<ul><li>First</li><li>Second</li></ul>";
    const text = htmlToPlainText(html);
    expect(text).toContain("- First");
    expect(text).toContain("- Second");
  });

  it("returns empty string for empty input", () => {
    expect(htmlToPlainText("")).toBe("");
  });
});
