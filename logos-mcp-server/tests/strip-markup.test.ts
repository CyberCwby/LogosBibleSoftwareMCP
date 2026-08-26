import { describe, it, expect } from "vitest";
import { stripXml, stripRichText } from "../src/utils/strip-markup.js";

describe("stripXml", () => {
  it("removes HTML/XML tags", () => {
    expect(stripXml("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("decodes HTML entities", () => {
    expect(stripXml("faith &amp; grace &lt;3&gt;")).toBe("faith & grace <3>");
  });

  it("normalizes whitespace", () => {
    expect(stripXml("hello   \n  world")).toBe("hello world");
  });

  it("returns null for null input", () => {
    expect(stripXml(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(stripXml("")).toBeNull();
  });

  it("decodes doubly-escaped entities only once (regression: &amp; decoded last)", () => {
    // Literal text discussing markup: "&amp;lt;" is an escaped "&lt;" and
    // must render as "&lt;", not be double-decoded into "<".
    expect(stripXml("use &amp;lt; to escape")).toBe("use &lt; to escape");
    expect(stripXml("&amp;quot; is an escaped quote")).toBe("&quot; is an escaped quote");
  });
});

describe("stripRichText", () => {
  it("extracts text from Logos XAML Run elements", () => {
    const xaml = '<Paragraph><Run FontSize="12" Text="Grace alone"/></Paragraph>';
    expect(stripRichText(xaml)).toBe("Grace alone");
  });

  it("joins multiple Run elements with spaces", () => {
    const xaml = '<Paragraph><Run Text="Hello"/><Run Text="world"/></Paragraph>';
    expect(stripRichText(xaml)).toBe("Hello world");
  });

  it("adds newlines between paragraphs", () => {
    const xaml = '<Paragraph><Run Text="Line one"/></Paragraph><Paragraph><Run Text="Line two"/></Paragraph>';
    expect(stripRichText(xaml)).toBe("Line one\nLine two");
  });

  it("falls back to stripXml for non-XAML content", () => {
    expect(stripRichText("<p>Simple HTML</p>")).toBe("Simple HTML");
  });

  it("returns null for null input", () => {
    expect(stripRichText(null)).toBeNull();
  });

  it("returns null for whitespace-only result", () => {
    const xaml = '<Paragraph><Run Text="   "/></Paragraph>';
    expect(stripRichText(xaml)).toBeNull();
  });

  it("handles Text attributes with single quotes", () => {
    const xaml = "<Paragraph><Run Text='Grace alone'/></Paragraph>";
    expect(stripRichText(xaml)).toBe("Grace alone");
  });

  it("keeps apostrophes inside double-quoted Text attributes (regression: truncation at first apostrophe)", () => {
    const xaml = '<Paragraph><Run Text="God\'s love endures forever" /></Paragraph>';
    expect(stripRichText(xaml)).toBe("God's love endures forever");
  });

  it("keeps double quotes inside single-quoted Text attributes, decoded", () => {
    // Both forms end up as real quote characters: `&quot;` is an escape the
    // reader should never see (M2, 2026-08-25 review), and a raw `"` inside a
    // single-quoted attribute is already the character it looks like.
    const xaml = "<Paragraph><Run Text='He said &quot;come&quot; — but also \"raw\" quotes'/></Paragraph>";
    expect(stripRichText(xaml)).toBe('He said "come" — but also "raw" quotes');
  });

  it("decodes XML entities in XAML attribute values (M2)", () => {
    // `&` MUST be escaped inside an XML attribute value, so every note
    // containing an ampersand was affected — and `get_user_notes`' full-text
    // filter runs over this content, so searching for "Faith & Works" missed a
    // note that literally contains that phrase.
    expect(stripRichText('<Paragraph><Run Text="Faith &amp; Works" /></Paragraph>'))
      .toBe("Faith & Works");
    expect(stripRichText('<Paragraph><Run Text="He said &quot;go&quot;" /></Paragraph>'))
      .toBe('He said "go"');
    expect(stripRichText("<Paragraph><Run Text='1 &lt; 2 &gt; 0' /></Paragraph>"))
      .toBe("1 < 2 > 0");
    expect(stripRichText('<Paragraph><Run Text="God&apos;s love" /></Paragraph>'))
      .toBe("God's love");
  });

  it("decodes a doubly-escaped entity exactly once (M2)", () => {
    // A note whose text literally contains "&lt;" is stored as "&amp;lt;" and
    // must come back as "&lt;", not as "<". This is why &amp; is decoded last.
    expect(stripRichText('<Paragraph><Run Text="&amp;lt; is a less-than" /></Paragraph>'))
      .toBe("&lt; is a less-than");
  });

  it("handles a mix of quote styles with apostrophes across multiple Runs", () => {
    const xaml = '<Paragraph><Run Text="It\'s written:"/><Run Text=\'the Lord"s\'/></Paragraph>';
    expect(stripRichText(xaml)).toBe('It\'s written: the Lord"s');
  });
});
