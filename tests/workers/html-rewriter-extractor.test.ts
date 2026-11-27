import { describe, expect, it } from "vitest";
import { HtmlRewriterExtractor } from "../../src/adapters/html/html-rewriter-extractor";
import { describeExtractorParity, FIXTURE_HTML } from "../fixtures/parity-cases";

describeExtractorParity("HtmlRewriterExtractor", () => new HtmlRewriterExtractor());

/** Streams `text` as UTF-8 in tiny chunks (splitting multi-byte characters and entities). */
function chunkedResponse(text: string, chunkSize: number): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

describe("HtmlRewriterExtractor — arbitrary chunk boundaries (17 bytes)", () => {
  const extractor = new HtmlRewriterExtractor();
  const url = "https://hoe.com.ua/x";

  it.each([
    ["main page", FIXTURE_HTML.mainPage],
    ["post of 25 Nov", FIXTURE_HTML.post1125],
    ["post of 26 Nov", FIXTURE_HTML.post1126],
  ])("schedule page is identical to single-buffer extraction: %s", async (_name, html) => {
    const whole = await extractor.extractSchedulePage(html, url);
    const chunked = await extractor.extractSchedulePageFromResponse(chunkedResponse(html, 17), url);
    expect(chunked).toEqual(whole);
  });

  it("news listing is identical to single-buffer extraction", async () => {
    const whole = await extractor.extractNewsListing(FIXTURE_HTML.newsPage, url);
    const chunked = await extractor.extractNewsListingFromResponse(
      chunkedResponse(FIXTURE_HTML.newsPage, 17),
      url,
    );
    expect(chunked).toEqual(whole);
    expect(chunked.items).toHaveLength(10);
  });

  it("entities split across chunks are still decoded", async () => {
    const html = '<div class="post"><p>&laquo;Тест&raquo;&nbsp;&#171;x&#187;</p></div>';
    for (const size of [1, 2, 3, 5, 7]) {
      const page = await extractor.extractSchedulePageFromResponse(chunkedResponse(html, size), url);
      expect(page.sections).toEqual([{ lines: ["«Тест» «x»"], imageAlts: [] }]);
    }
  });
});
