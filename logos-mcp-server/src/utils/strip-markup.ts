/**
 * Shared markup stripping utilities for cleaning MCP tool responses.
 */

/**
 * Remove XML/HTML tags and decode common entities.
 * Returns null if input is null or result is empty.
 */
/**
 * Decode the XML entities Logos content actually uses.
 *
 * `&amp;` is decoded LAST: text that literally contains an escaped entity
 * (e.g. "&amp;lt;") must decode once to "&lt;", not twice to "<".
 *
 * Shared by `stripXml` and the XAML path, which used to push raw attribute
 * values straight through — so a note reading `Text="Faith &amp; Works"` came
 * back as the literal `Faith &amp; Works`. `&` MUST be escaped inside an XML
 * attribute value, so every note containing an ampersand was affected, and a
 * quotation inside a double-quoted attribute is necessarily `&quot;`.
 */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function stripXml(text: string | null): string | null {
  if (!text) return null;
  const result = decodeXmlEntities(text.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  return result.length > 0 ? result : null;
}

/**
 * Extract plain text from Logos XAML RichText content.
 * Handles <Run Text="..."/> elements across <Paragraph> blocks.
 * Falls back to generic stripXml for non-XAML content.
 */
export function stripRichText(text: string | null): string | null {
  if (!text) return null;

  // Check if this looks like Logos XAML (has Run elements with Text attributes)
  if (!text.includes("<Run ")) {
    return stripXml(text);
  }

  // Split by paragraph boundaries
  const paragraphs = text.split(/<\/Paragraph>\s*<Paragraph[^>]*>/i);

  const lines: string[] = [];
  for (const para of paragraphs) {
    // Extract all Text="..." or Text='...' attribute values. Each quote
    // style is matched separately so a double-quoted value may contain raw
    // single quotes (XAML writers do not escape apostrophes) and vice versa.
    const texts: string[] = [];
    const regex = /Text=(?:"([^"]*)"|'([^']*)')/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(para)) !== null) {
      // Decoded, not raw. `get_user_notes`' full-text `query` filter runs over
      // this content, so an undecoded value also made searching for
      // "Faith & Works" miss a note that literally contains that phrase.
      const value = decodeXmlEntities(match[1] ?? match[2] ?? "");
      if (value.trim()) {
        texts.push(value);
      }
    }
    if (texts.length > 0) {
      lines.push(texts.join(" "));
    }
  }

  const result = lines.join("\n").trim();
  return result.length > 0 ? result : null;
}
