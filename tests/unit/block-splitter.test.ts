import { describe, expect, it } from "vitest";
import { CheerioHtmlExtractor } from "../../src/adapters/html/cheerio-extractor";
import { extractRawBlocks, isBoilerplateLine } from "../../src/core/scraping";
import { FIXTURE_HTML } from "../fixtures/parity-cases";

const extractor = new CheerioHtmlExtractor();
const URL_BASE = "https://hoe.com.ua/page/pogodinni-vidkljuchennja";
const REF = "2026-11-27";

async function blocksFor(html: string, ref = REF) {
  const page = await extractor.extractSchedulePage(html, URL_BASE);
  return extractRawBlocks(page, ref);
}

describe("extractRawBlocks — legacy scenarios", () => {
  it("modern <br>-separated subqueues with <hr> and a footer", async () => {
    const blocks = await blocksFor(
      '<div class="post"><p>За розпорядженням НЕК «Укренерго» на 07 листопада</p>' +
        "<p>Підчерга 1.1 – 00:00-04:00; 09:00-13:00.<br/>Підчерга 1.2 – 10:00-14:00.</p>" +
        "<hr><p>Перевірити чергу</p></div>",
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      date: "2026-11-07",
      dateSource: "text",
      scheduleText: "Підчерга 1.1 – 00:00-04:00; 09:00-13:00.\nПідчерга 1.2 – 10:00-14:00.",
      extrasText: "За розпорядженням НЕК «Укренерго» на 07 листопада",
    });
  });

  it("legacy html with image alt date and an operational note", async () => {
    const blocks = await blocksFor(
      '<div class="post"><p><img alt="ГПВ-20.01.26"></p>' +
        "<ul><li>підчерга 1.1 – з 10:00 до 15:00;</li></ul>" +
        "<p>Додатково буде знеструмлено підчергу 1.1 з 16:00 до 18:00</p></div>",
      "2026-01-25",
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      date: "2026-01-20",
      dateSource: "image_alt",
      scheduleText: "підчерга 1.1 – з 10:00 до 15:00;",
    });
    expect(blocks[0]?.extrasText).toContain("Додатково буде знеструмлено");
  });

  it("two days separated by <hr>", async () => {
    const blocks = await blocksFor(
      '<div class="post"><p>На 07 листопада</p><p>Підчерга 1.1 – 06:00-09:00.</p><hr>' +
        "<p>На 08 листопада</p><p>Підчерга 1.1 – 07:00-10:00.</p></div>",
    );
    expect(blocks.map((b) => b.date)).toEqual(["2026-11-07", "2026-11-08"]);
  });

  it("splits two announcements that are not separated by <hr>", async () => {
    const blocks = await blocksFor(
      '<div class="post">' +
        "<p>За розпорядженням НЕК «Укренерго» на 07 листопада</p><p>Підчерга 1.1 – 06:00-09:00.</p>" +
        "<p>За розпорядженням НЕК «Укренерго» оновлено графік на 07 листопада</p><p>Підчерга 1.1 – 07:00-10:00.</p>" +
        "</div>",
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.scheduleText).toBe("Підчерга 1.1 – 06:00-09:00.");
    expect(blocks[1]?.scheduleText).toBe("Підчерга 1.1 – 07:00-10:00.");
  });

  it("strips boilerplate disclaimers but keeps the announcement header", async () => {
    const blocks = await blocksFor(
      '<div class="post"><p>За розпорядженням НЕК «Укренерго» на 07 листопада</p>' +
        "<p>Підчерга 1.1 – 06:00-09:00.</p>" +
        "<p>Для промислових споживачів діятиме графік обмеження.</p>" +
        "<p>Наголошуємо, що головною причиною запровадження є обстріли.</p>" +
        "<p>Зверніть увагу, це прогноз відключень.</p>" +
        "<p>Перевірити свою чергу можна на сайті.</p>" +
        "<p>Відділ зв'язків з громадськістю</p></div>",
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.extrasText).toBe("За розпорядженням НЕК «Укренерго» на 07 листопада");
  });

  it("keeps the plural additive header and collapses NBSP/multiple spaces", async () => {
    const blocks = await blocksFor(
      '<div class="post"><p>За розпорядженням НЕК «Укренерго» на 23 листопада</p>' +
        "<p>Додаткові&nbsp;&nbsp;години   відсутності електроенергії:</p>" +
        "<p>Підчерги&nbsp;5.2,  6.2 – 21:30-24:00.</p></div>",
    );
    expect(blocks[0]?.extrasText).toContain("Додаткові години відсутності електроенергії:");
    expect(blocks[0]?.scheduleText).toBe("Підчерги 5.2, 6.2 – 21:30-24:00.");
  });

  it("returns nothing for pages without schedule content", async () => {
    expect(await blocksFor('<div class="post"><p>Нічого</p></div>')).toEqual([]);
    expect(await blocksFor("<html><body><p>x</p></body></html>")).toEqual([]);
  });
});

describe("extractRawBlocks — fixes over the Python scraper", () => {
  it("keeps inline <strong> on the same line as the interval", async () => {
    const blocks = await blocksFor(
      '<div class="post"><p>На 07 листопада</p><p><strong>Підчерга 1.1</strong> – 06:00-09:00.</p></div>',
    );
    expect(blocks[0]?.scheduleText).toBe("Підчерга 1.1 – 06:00-09:00.");
  });

  it("splits on <hr> nested in a wrapper <div>", async () => {
    const blocks = await blocksFor(
      '<div class="post"><div><p>На 07 листопада</p><p>Підчерга 1.1 – 06:00-09:00.</p><hr/>' +
        "<p>На 08 листопада</p><p>Підчерга 1.1 – 07:00-10:00.</p></div></div>",
    );
    expect(blocks.map((b) => b.date)).toEqual(["2026-11-07", "2026-11-08"]);
  });
});

describe("extractRawBlocks — live fixtures", () => {
  it("main page: exactly three schedule blocks, no REM/file noise", async () => {
    const blocks = await blocksFor(FIXTURE_HTML.mainPage);
    expect(blocks.map((b) => b.date)).toEqual(["2026-11-27", "2026-11-26", "2026-11-26"]);
    for (const block of blocks) {
      expect(block.dateSource).toBe("text");
      expect(block.scheduleText.split("\n")).toHaveLength(12);
      expect(block.scheduleText).not.toMatch(/pdf|xlsx|GPV6/i);
    }
    expect(blocks[1]?.extrasText).toContain("(оновлено 23:40)");
  });

  it("post of 25 Nov: year-less delta header resolves via publish date context", async () => {
    // Reference date is far away; only the publish date "24 Лис 2026" can supply the year.
    const blocks = await blocksFor(FIXTURE_HTML.post1125, "2027-05-01");
    expect(blocks.map((b) => b.date)).toEqual(["2026-11-25", "2026-11-25", "2026-11-25"]);
    expect(blocks[0]?.scheduleText).toBe("Підчерга 1.1 - 22:00-24:00");
    expect(blocks[0]?.extrasText).toContain("Додаткові години відсутності електроенергії:");
    expect(blocks[0]?.extrasText).toContain("(оновлено з 21:35)");
    expect(blocks[1]?.scheduleText.split("\n")).toHaveLength(12);
    expect(blocks[2]?.scheduleText.split("\n")).toHaveLength(12);
  });

  it("post of 27 Nov: one block, trailing boilerplate removed", async () => {
    const blocks = await blocksFor(FIXTURE_HTML.post1127);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.date).toBe("2026-11-27");
    expect(blocks[0]?.extrasText).not.toContain("промислових");
    expect(blocks[0]?.extrasText).not.toContain("Відділ");
  });

  it("news listing page yields no blocks", async () => {
    expect(await blocksFor(FIXTURE_HTML.newsPage)).toEqual([]);
  });
});

describe("isBoilerplateLine", () => {
  it("matches known prefixes, case and apostrophe variants", () => {
    expect(isBoilerplateLine("Відділ зв’язків з громадськістю")).toBe(true);
    expect(isBoilerplateLine("ВАЖЛИВО: тест")).toBe(true);
    expect(isBoilerplateLine("Перевірити чергу")).toBe(true);
    expect(isBoilerplateLine("Підчерга 1.1 – 06:00-09:00.")).toBe(false);
  });
});
