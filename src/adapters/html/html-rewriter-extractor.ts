import type { HtmlExtractor } from "../../core/ports/html-extractor";
import type {
  ExtractedNewsItem,
  ExtractedNewsListing,
  ExtractedSchedulePage,
  ExtractedSection,
} from "../../core/types/extracted";
import { decodeHtmlEntities, normalizeLine } from "./entities";

const BLOCK_SELECTOR = [
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
]
  .map((tag) => `div.post ${tag}`)
  .join(", ");

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** HTMLRewriter is lazy: the body must be consumed for handlers to run. */
async function drain(response: Response): Promise<void> {
  if (response.body) {
    await response.body.pipeTo(new WritableStream());
  } else {
    await response.arrayBuffer();
  }
}

function clean(raw: string): string {
  return normalizeLine(decodeHtmlEntities(raw));
}

/**
 * Production extractor for Cloudflare Workers, built on the native streaming HTMLRewriter.
 * Must stay behaviourally identical to `CheerioHtmlExtractor`.
 */
export class HtmlRewriterExtractor implements HtmlExtractor {
  extractSchedulePage(html: string, url: string): Promise<ExtractedSchedulePage> {
    return this.extractSchedulePageFromResponse(htmlResponse(html), url);
  }

  extractNewsListing(html: string, url: string): Promise<ExtractedNewsListing> {
    return this.extractNewsListingFromResponse(htmlResponse(html), url);
  }

  async extractSchedulePageFromResponse(
    response: Response,
    url: string,
  ): Promise<ExtractedSchedulePage> {
    let heading: string | null = null;
    let h1Seen = false;
    let h1Active = false;
    let h1Raw = "";

    let publishDateText: string | null = null;
    let publishDateDecided = false;
    let itemActive = false;
    let itemHasCalendar = false;
    let itemRaw = "";

    let postSeen = false;
    let inPost = false;
    let skipDepth = 0;
    let lineRaw = "";
    let current: ExtractedSection = { lines: [], imageAlts: [] };
    const sections: ExtractedSection[] = [];

    const active = (): boolean => inPost && skipDepth === 0;
    const flushLine = (): void => {
      const line = clean(lineRaw);
      lineRaw = "";
      if (line) current.lines.push(line);
    };
    const commitSection = (): void => {
      if (current.lines.length > 0 || current.imageAlts.length > 0) {
        sections.push(current);
        current = { lines: [], imageAlts: [] };
      }
    };

    const rewriter = new HTMLRewriter()
      .on("h1", {
        element(el) {
          if (h1Seen) return;
          h1Seen = true;
          h1Active = true;
          el.onEndTag(() => {
            h1Active = false;
            heading = clean(h1Raw) || null;
          });
        },
        text(chunk) {
          if (h1Active) h1Raw += chunk.text;
        },
      })
      .on("div.page-top div.data-item", {
        element(el) {
          itemActive = true;
          itemHasCalendar = false;
          itemRaw = "";
          el.onEndTag(() => {
            if (itemHasCalendar && !publishDateDecided) {
              publishDateDecided = true;
              publishDateText = clean(itemRaw) || null;
            }
            itemActive = false;
          });
        },
        text(chunk) {
          if (itemActive) itemRaw += chunk.text;
        },
      })
      .on("div.page-top div.data-item i.fa-calendar", {
        element() {
          if (itemActive) itemHasCalendar = true;
        },
      })
      .on("div.post", {
        element(el) {
          if (postSeen) return;
          postSeen = true;
          inPost = true;
          el.onEndTag(() => {
            flushLine();
            commitSection();
            inPost = false;
          });
        },
        text(chunk) {
          if (active()) lineRaw += chunk.text;
        },
      })
      .on("div.post script, div.post style", {
        element(el) {
          if (!inPost) return;
          skipDepth++;
          el.onEndTag(() => {
            skipDepth--;
          });
        },
      })
      .on("div.post hr", {
        element() {
          if (!active()) return;
          flushLine();
          commitSection();
        },
      })
      .on("div.post br", {
        element() {
          if (active()) flushLine();
        },
      })
      .on(BLOCK_SELECTOR, {
        element(el) {
          if (!active()) return;
          flushLine();
          el.onEndTag(() => {
            if (active()) flushLine();
          });
        },
      })
      .on("div.post img[alt]", {
        element(el) {
          if (!active()) return;
          const alt = clean(el.getAttribute("alt") ?? "");
          if (alt) current.imageAlts.push(alt);
        },
      });

    await drain(rewriter.transform(response));

    return { url, heading, publishDateText, hasExpectedContainer: postSeen, sections };
  }

  async extractNewsListingFromResponse(
    response: Response,
    url: string,
  ): Promise<ExtractedNewsListing> {
    const items: ExtractedNewsItem[] = [];
    let item: ExtractedNewsItem | null = null;
    let dateDecided = false;

    let titleActive = false;
    let titleRaw = "";

    let spanActive = false;
    let spanHasCalendar = false;
    let spanRaw = "";

    const rewriter = new HTMLRewriter()
      .on("div.news-list article.item", {
        element(el) {
          item = { href: "", title: "", publishDateText: null };
          dateDecided = false;
          el.onEndTag(() => {
            if (item && item.href) items.push(item);
            item = null;
          });
        },
      })
      .on("div.news-list article.item .heading a", {
        element(el) {
          if (!item || item.href !== "") return;
          const href = decodeHtmlEntities(el.getAttribute("href") ?? "").trim();
          if (!href) return;
          titleActive = true;
          titleRaw = "";
          el.onEndTag(() => {
            if (item) {
              item.href = href;
              item.title = clean(titleRaw);
            }
            titleActive = false;
          });
        },
        text(chunk) {
          if (titleActive) titleRaw += chunk.text;
        },
      })
      .on("div.news-list article.item .item-footer span", {
        element(el) {
          spanActive = true;
          spanHasCalendar = false;
          spanRaw = "";
          el.onEndTag(() => {
            if (spanHasCalendar && item && !dateDecided) {
              dateDecided = true;
              item.publishDateText = clean(spanRaw) || null;
            }
            spanActive = false;
          });
        },
        text(chunk) {
          if (spanActive) spanRaw += chunk.text;
        },
      })
      .on("div.news-list article.item .item-footer span i.fa-calendar", {
        element() {
          if (spanActive) spanHasCalendar = true;
        },
      });

    await drain(rewriter.transform(response));

    return { url, items };
  }
}
