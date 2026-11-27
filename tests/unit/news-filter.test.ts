import { describe, expect, it } from "vitest";
import { CheerioHtmlExtractor } from "../../src/adapters/html/cheerio-extractor";
import { filterNewsScheduleCandidates } from "../../src/core/scraping";
import type { ExtractedNewsListing } from "../../src/core/types/extracted";
import { FIXTURE_HTML } from "../fixtures/parity-cases";

const NEWS_URL = "https://hoe.com.ua/post/novini-kompaniji";

function listing(items: Array<[string, string]>): ExtractedNewsListing {
  return {
    url: NEWS_URL,
    items: items.map(([href, title]) => ({ href, title, publishDateText: null })),
  };
}

describe("filterNewsScheduleCandidates", () => {
  it("skips FAQ, explainer posts and titles with '?'", () => {
    const result = filterNewsScheduleCandidates(
      listing([
        ["/post/chi-vigidno-vidkljuchati.html", "Чи вигідно відключати світло?"],
        ["/post/chomu-grafiki-zminjujutsja.html", "Чому графіки змінюються"],
        ["/post/pitannjavidpovid-gpv.html", "Питання-відповіді про ГПВ"],
        ["/post/prognoz-gpv-na-25-listopada.html", "Прогноз ГПВ на 25 листопада"],
        ["/post/pogodinni-vidkljuchennja-na-24-listopada.html", "Погодинні відключення на 24"],
      ]),
    );
    expect(result.map((c) => c.url)).toEqual([
      "https://hoe.com.ua/post/prognoz-gpv-na-25-listopada.html",
      "https://hoe.com.ua/post/pogodinni-vidkljuchennja-na-24-listopada.html",
    ]);
  });

  it("resolves hrefs without a leading slash and absolute hrefs", () => {
    const result = filterNewsScheduleCandidates(
      listing([
        ["post/prognoz-gpv-na-25-listopada.html", "Прогноз ГПВ на 25 листопада"],
        ["https://hoe.com.ua/post/prognoz-gpv-na-26-listopada.html", "Прогноз ГПВ на 26 листопада"],
      ]),
    );
    expect(result.map((c) => c.url)).toEqual([
      "https://hoe.com.ua/post/prognoz-gpv-na-25-listopada.html",
      "https://hoe.com.ua/post/prognoz-gpv-na-26-listopada.html",
    ]);
  });

  it("falls back to title keywords after URL-matched posts and deduplicates", () => {
    const result = filterNewsScheduleCandidates(
      listing([
        ["/post/nova-informacija.html", "Графік погодинних відключень оновлено"],
        ["/post/prognoz-gpv-na-25-listopada.html", "Прогноз ГПВ на 25 листопада"],
        ["/post/prognoz-gpv-na-25-listopada.html", "Прогноз ГПВ на 25 листопада"],
      ]),
    );
    expect(result.map((c) => c.url)).toEqual([
      "https://hoe.com.ua/post/prognoz-gpv-na-25-listopada.html",
      "https://hoe.com.ua/post/nova-informacija.html",
    ]);
  });

  it("rejects industrial GOP posts, non-post links and respects the limit", () => {
    const result = filterNewsScheduleCandidates(
      listing([
        ["/post/27112026-dijatime-gop.html", "Прогноз ГПВ — діятиме ГОП"],
        ["/page/prognoz-gpv.html", "Прогноз ГПВ"],
        ["/post/prognoz-gpv-na-1-listopada.html", "Прогноз ГПВ на 1 листопада"],
        ["/post/prognoz-gpv-na-2-listopada.html", "Прогноз ГПВ на 2 листопада"],
      ]),
      1,
    );
    expect(result.map((c) => c.url)).toEqual(["https://hoe.com.ua/post/prognoz-gpv-na-1-listopada.html"]);
  });

  it("returns [] for an invalid listing url", () => {
    expect(filterNewsScheduleCandidates({ url: "not a url", items: [] })).toEqual([]);
  });

  it("live news page: exactly the seven schedule posts, no false positives", async () => {
    const parsed = await new CheerioHtmlExtractor().extractNewsListing(
      FIXTURE_HTML.newsPage,
      NEWS_URL,
    );
    const result = filterNewsScheduleCandidates(parsed, 10);
    expect(result.map((c) => c.url)).toEqual([
      "https://hoe.com.ua/post/prognoz-gpv-na-27-listopada.html",
      "https://hoe.com.ua/post/prognoz-gpv-na-26-listopada.html",
      "https://hoe.com.ua/post/pogodinni-vidkljuchennja-na-25-listopada.html",
      "https://hoe.com.ua/post/prognoz-gpv-na-24-listopada-.html",
      "https://hoe.com.ua/post/prognoz-gpv-na-23-listopada.html",
      "https://hoe.com.ua/post/prognoz-gpv-na-22-listopada.html",
      "https://hoe.com.ua/post/prognoz-gpv-na-21-listopada.html",
    ]);
    expect(result.map((c) => c.publishDate)).toEqual([
      "2026-11-26",
      "2026-11-25",
      "2026-11-24",
      "2026-11-23",
      "2026-11-22",
      "2026-11-21",
      "2026-11-20",
    ]);
  });
});
