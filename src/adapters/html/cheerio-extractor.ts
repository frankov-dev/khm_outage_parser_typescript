import * as cheerio from "cheerio";
import type { HtmlExtractor } from "../../core/ports/html-extractor";
import type {
  ExtractedNewsItem,
  ExtractedNewsListing,
  ExtractedSchedulePage,
  ExtractedSection,
} from "../../core/types/extracted";
import { normalizeLine } from "./entities";

/** Minimal structural view of a domhandler node (avoids depending on its types). */
interface DomNode {
  type: string;
  data?: string;
  name?: string;
  children?: DomNode[];
  attribs?: Record<string, string>;
}

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "p",
  "div",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "blockquote",
  "pre",
  "section",
  "article",
  "ul",
  "ol",
  "table",
]);

const ELEMENT_TYPES: ReadonlySet<string> = new Set(["tag", "script", "style"]);

/**
 * Dev/test extractor (Node). Never imported by the Worker bundle.
 * Must stay behaviourally identical to `HtmlRewriterExtractor`.
 * Text nodes are already entity-decoded by the parser.
 */
export class CheerioHtmlExtractor implements HtmlExtractor {
  extractSchedulePage(html: string, url: string): Promise<ExtractedSchedulePage> {
    const $ = cheerio.load(html);

    const heading = normalizeLine($("h1").first().text()) || null;

    let publishDateText: string | null = null;
    for (const el of $("div.page-top div.data-item").toArray()) {
      if ($(el).find("i.fa-calendar").length > 0) {
        publishDateText = normalizeLine($(el).text()) || null;
        break;
      }
    }

    const post = $("div.post").first();
    const sections: ExtractedSection[] = [];

    if (post.length > 0) {
      let lineBuf = "";
      let current: ExtractedSection = { lines: [], imageAlts: [] };

      const flushLine = (): void => {
        const line = normalizeLine(lineBuf);
        lineBuf = "";
        if (line) current.lines.push(line);
      };
      const commitSection = (): void => {
        if (current.lines.length > 0 || current.imageAlts.length > 0) {
          sections.push(current);
          current = { lines: [], imageAlts: [] };
        }
      };

      const walk = (node: DomNode): void => {
        if (node.type === "text") {
          lineBuf += node.data ?? "";
          return;
        }
        if (!ELEMENT_TYPES.has(node.type)) return;

        const name = (node.name ?? "").toLowerCase();
        if (name === "script" || name === "style") return;
        if (name === "hr") {
          flushLine();
          commitSection();
          return;
        }
        if (name === "br") {
          flushLine();
          return;
        }
        if (name === "img") {
          const alt = normalizeLine(node.attribs?.["alt"] ?? "");
          if (alt) current.imageAlts.push(alt);
          return;
        }

        const isBlock = BLOCK_TAGS.has(name);
        if (isBlock) flushLine();
        for (const child of node.children ?? []) walk(child);
        if (isBlock) flushLine();
      };

      const root = post.get(0) as unknown as DomNode;
      for (const child of root.children ?? []) walk(child);
      flushLine();
      commitSection();
    }

    return Promise.resolve({
      url,
      heading,
      publishDateText,
      hasExpectedContainer: post.length > 0,
      sections,
    });
  }

  extractNewsListing(html: string, url: string): Promise<ExtractedNewsListing> {
    const $ = cheerio.load(html);
    const items: ExtractedNewsItem[] = [];

    for (const card of $("div.news-list article.item").toArray()) {
      const anchor = $(card)
        .find(".heading a")
        .toArray()
        .find((a) => ($(a).attr("href") ?? "").trim() !== "");
      if (!anchor) continue;

      const href = ($(anchor).attr("href") ?? "").trim();
      const title = normalizeLine($(anchor).text());

      let publishDateText: string | null = null;
      for (const span of $(card).find(".item-footer span").toArray()) {
        if ($(span).find("i.fa-calendar").length > 0) {
          publishDateText = normalizeLine($(span).text()) || null;
          break;
        }
      }

      items.push({ href, title, publishDateText });
    }

    return Promise.resolve({ url, items });
  }
}
