import { describe, expect, it } from "vitest";
import type { HtmlExtractor } from "../../src/core/ports/html-extractor";
import mainPage from "./html/main_page.html?raw";
import newsPage from "./html/news_page.html?raw";
import post1125 from "./html/news_post_2026-11-25.html?raw";
import post1126 from "./html/news_post_2026-11-26.html?raw";
import post1127 from "./html/news_post_2026-11-27.html?raw";

export const FIXTURE_HTML = {
  mainPage,
  newsPage,
  post1125,
  post1126,
  post1127,
} as const;

export const SYNTHETIC_HTML = {
  inlineTags:
    '<html><body><div class="post"><p><strong>Підчерга 1.1</strong> – <span>06:00-09:00</span>.</p></div></body></html>',
  nestedDivWithHr:
    '<div class="post"><div class="inner"><img alt="ГПВ-20.01.26"><ul><li>підчерга 1.1 – з 10:00 до 15:00;</li></ul><hr><p>Підчерга 2.1 – 08:00-10:00.</p></div></div>',
  modalTrap:
    '<html><body><main><h1>T &amp; U</h1><div class="post"></div></main><div id="modalAttantion"><article><p>За розпорядженням НЕК &laquo;Укренерго&raquo;, на Хмельниччині запроваджені графіки.</p></article></div></body></html>',
  entities:
    '<div class="post"><p>&laquo;Тест&raquo;&nbsp;&#171;x&#187; &amp; &#x41;</p><p>a<br>b<script>var x = 1;</script></p></div>',
} as const;

const URL_BASE = "https://hoe.com.ua/page/pogodinni-vidkljuchennja";
const NEWS_URL = "https://hoe.com.ua/post/novini-kompaniji";

/**
 * Registers the shared behavioural contract that every `HtmlExtractor`
 * implementation (Cheerio in Node, HTMLRewriter in workerd) must satisfy.
 */
export function describeExtractorParity(name: string, create: () => HtmlExtractor): void {
  describe(`${name} — live fixtures`, () => {
    it("main page: three schedule sections, no modal/sidebar leakage", async () => {
      const page = await create().extractSchedulePage(FIXTURE_HTML.mainPage, URL_BASE);
      expect(page.heading).toBe("Погодинні відключення");
      expect(page.publishDateText).toBeNull();
      expect(page.hasExpectedContainer).toBe(true);
      expect(page.sections).toHaveLength(13);
      expect(page.sections.slice(0, 3).map((s) => s.lines.length)).toEqual([14, 14, 14]);
      expect(page.sections.every((s) => s.imageAlts.length === 0)).toBe(true);

      const [s1, s2, s3] = page.sections;
      expect(s1?.lines[0]).toBe(
        "За розпорядженням НЕК «Укренерго» 27.11.2026 р. на Хмельниччині будуть застосовані графіки погодинних відключень (ГПВ).",
      );
      expect(s1?.lines[1]).toBe("Години відсутності електроенергії:");
      expect(s1?.lines[2]).toBe(
        "Підчерга 1.1 – 06:00-08:00; 11:00-14:00; 17:00-20:00; 22:00-24:00.",
      );
      expect(s1?.lines[13]).toBe("Підчерга 6.2 – 08:00-11:00; 14:00-17:00; 20:00-22:00.");
      // Trailing NBSP after "(оновлено 23:40)." must be normalised away.
      expect(s2?.lines[0]).toBe(
        "За розпорядженням НЕК «Укренерго» оновлено графік погодинних відключень (ГПВ) на 26.11.2026 р. (оновлено 23:40).",
      );
      expect(s3?.lines[0]).toContain("26.11.2026 р. на Хмельниччині");

      const all = JSON.stringify(page.sections);
      expect(all).not.toContain("запроваджені графіки");
      expect(all).not.toContain("\uFEFF");
      expect(all).not.toContain("\u00A0");
    });

    it("main page has no news listing", async () => {
      const listing = await create().extractNewsListing(FIXTURE_HTML.mainPage, URL_BASE);
      expect(listing.items).toEqual([]);
    });

    it("post 27 Nov: single section with publish date and heading", async () => {
      const page = await create().extractSchedulePage(FIXTURE_HTML.post1127, URL_BASE);
      expect(page.heading).toBe("Прогноз ГПВ на 27 листопада");
      expect(page.publishDateText).toBe("26 Лис 2026");
      expect(page.sections.map((s) => s.lines.length)).toEqual([18]);
      expect(page.sections[0]?.lines.at(-1)).toBe("Відділ зв'язків з громадськістю");
    });

    it("post 26 Nov: two sections separated by <hr>", async () => {
      const page = await create().extractSchedulePage(FIXTURE_HTML.post1126, URL_BASE);
      expect(page.heading).toBe("Прогноз ГПВ на 26 листопада (ОНОВЛЕНО, 23:40)");
      expect(page.publishDateText).toBe("25 Лис 2026");
      expect(page.sections.map((s) => s.lines.length)).toEqual([14, 22]);
    });

    it("post 25 Nov: delta block is split on <br> inside a single <p>", async () => {
      const page = await create().extractSchedulePage(FIXTURE_HTML.post1125, URL_BASE);
      expect(page.heading).toBe("Погодинні відключення на 25 листопада (ОНОВЛЕНО, 21:35)");
      expect(page.publishDateText).toBe("24 Лис 2026");
      expect(page.sections.map((s) => s.lines.length)).toEqual([3, 14, 18]);
      expect(page.sections[0]?.lines).toEqual([
        "За розпорядженням НЕК «Укренерго» оновлено графік погодинних відключень (ГПВ) на 25 листопада (оновлено з 21:35).",
        "Додаткові години відсутності електроенергії:",
        "Підчерга 1.1 - 22:00-24:00",
      ]);
    });

    it("news listing: ten cards, only .heading anchors, entities decoded", async () => {
      const listing = await create().extractNewsListing(FIXTURE_HTML.newsPage, NEWS_URL);
      expect(listing.items).toHaveLength(10);
      expect(listing.items[0]).toEqual({
        href: "/post/prognoz-gpv-na-27-listopada.html",
        title: "Прогноз ГПВ на 27 листопада",
        publishDateText: "26 Лис 2026",
      });
      expect(listing.items[2]?.title).toBe(
        "Відкритий діалог зі споживачами: директори РЕМ АТ «Хмельницькобленерго» проводять особисті прийоми",
      );
      expect(listing.items[3]?.href).toBe("/post/pogodinni-vidkljuchennja-na-25-listopada.html");
      expect(listing.items.every((i) => i.title !== "" && i.publishDateText !== null)).toBe(true);
    });

    it("news page: empty div.post yields no sections but a container", async () => {
      const page = await create().extractSchedulePage(FIXTURE_HTML.newsPage, NEWS_URL);
      expect(page.heading).toBe("Новини Компанії");
      expect(page.hasExpectedContainer).toBe(true);
      expect(page.sections).toEqual([]);
    });
  });

  describe(`${name} — synthetic edge cases`, () => {
    it("keeps inline tags on one line", async () => {
      const page = await create().extractSchedulePage(SYNTHETIC_HTML.inlineTags, URL_BASE);
      expect(page.sections).toEqual([{ lines: ["Підчерга 1.1 – 06:00-09:00."], imageAlts: [] }]);
    });

    it("splits on <hr> nested inside a wrapper <div> and collects img alt", async () => {
      const page = await create().extractSchedulePage(SYNTHETIC_HTML.nestedDivWithHr, URL_BASE);
      expect(page.sections).toEqual([
        { lines: ["підчерга 1.1 – з 10:00 до 15:00;"], imageAlts: ["ГПВ-20.01.26"] },
        { lines: ["Підчерга 2.1 – 08:00-10:00."], imageAlts: [] },
      ]);
    });

    it("ignores the modal <article> and decodes heading entities", async () => {
      const page = await create().extractSchedulePage(SYNTHETIC_HTML.modalTrap, URL_BASE);
      expect(page.heading).toBe("T & U");
      expect(page.hasExpectedContainer).toBe(true);
      expect(page.sections).toEqual([]);
    });

    it("decodes entities, splits on <br> and skips <script>", async () => {
      const page = await create().extractSchedulePage(SYNTHETIC_HTML.entities, URL_BASE);
      expect(page.sections).toEqual([
        { lines: ["«Тест» «x» & A", "a", "b"], imageAlts: [] },
      ]);
    });

    it("reports a missing container", async () => {
      const page = await create().extractSchedulePage("<html><body><p>x</p></body></html>", URL_BASE);
      expect(page.hasExpectedContainer).toBe(false);
      expect(page.sections).toEqual([]);
    });
  });
}
