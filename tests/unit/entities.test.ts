import { describe, expect, it } from "vitest";
import {
  cleanTextChunk,
  decodeHtmlEntities,
  normalizeLine,
} from "../../src/adapters/html/entities";

describe("decodeHtmlEntities", () => {
  it("decodes named entities", () => {
    expect(decodeHtmlEntities("&laquo;Т&raquo; &amp; &ndash; &mdash; &hellip;")).toBe("«Т» & – — …");
    expect(decodeHtmlEntities("a&nbsp;b")).toBe("a\u00A0b");
  });

  it("decodes decimal and hex references", () => {
    expect(decodeHtmlEntities("&#171;x&#187;")).toBe("«x»");
    expect(decodeHtmlEntities("&#160;")).toBe("\u00A0");
    expect(decodeHtmlEntities("&#xAB;&#xbb;")).toBe("«»");
  });

  it("leaves unknown and out-of-range references untouched", () => {
    expect(decodeHtmlEntities("&unknownentity; &#1114112; &constructor;")).toBe(
      "&unknownentity; &#1114112; &constructor;",
    );
  });

  it("is single-pass (no double decoding)", () => {
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
  });

  it("tolerates uppercase named entities", () => {
    expect(decodeHtmlEntities("a&NBSP;b")).toBe("a\u00A0b");
  });
});

describe("text normalisation", () => {
  it("strips BOM and zero-width space", () => {
    expect(cleanTextChunk("\uFEFFa\u200Bb")).toBe("ab");
  });

  it("turns newlines, tabs and NBSP into single spaces", () => {
    expect(normalizeLine("  a\r\n\t\u00A0b   c \u00A0")).toBe("a b c");
    expect(normalizeLine("\r\n\r\n")).toBe("");
  });

  it("treats &nbsp; and literal NBSP identically", () => {
    expect(normalizeLine(decodeHtmlEntities("x&nbsp;y"))).toBe(normalizeLine("x\u00A0y"));
  });
});
