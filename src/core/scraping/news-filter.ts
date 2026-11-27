import { extractPublishDate } from "../time/date-extractor";
import type { DateIso } from "../types/domain";
import type { ExtractedNewsListing } from "../types/extracted";

export interface NewsCandidate {
  url: string;
  title: string;
  publishDate: DateIso | null;
}

const EXCLUDED_HREF_KEYWORDS: readonly string[] = [
  "chomu-",
  "pitannjavidpovid",
  "chi-vigidno",
  "jak-pratsjuje",
  "riznitsja",
  "povnij-gajd",
  "olega-ivasika",
  "v-omanu",
  "dijatime-gop",
  "novini-kompaniji",
];

const SCHEDULE_HREF_PATTERN =
  /\/post\/(?:prognoz-gpv|pogodinni-vidkljuchennja-na|prognoz-obmezhen-na|grafik-(?:pogodinnih-)?vidkljuchen-na|grafiki-obmezhen-na|uvaga-zmini-grafika)/i;

const TITLE_FALLBACK_KEYWORDS: readonly string[] = [
  "погодинні відключення",
  "прогноз гпв",
  "графік погодинних",
  "графік відключень",
];

/**
 * Picks likely schedule posts from the news listing: explicit URL allow-list first,
 * then title keywords; FAQ/explainer posts and industrial (ГОП) posts are rejected.
 */
export function filterNewsScheduleCandidates(
  listing: ExtractedNewsListing,
  limit = 3,
): NewsCandidate[] {
  let baseOrigin: string;
  try {
    baseOrigin = `${new URL(listing.url).origin}/`;
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const tier1: NewsCandidate[] = [];
  const tier2: NewsCandidate[] = [];

  for (const item of listing.items) {
    let resolved: URL;
    try {
      // Resolve against the site origin so `post/x.html` and `/post/x.html` behave identically.
      resolved = new URL(item.href, baseOrigin);
    } catch {
      continue;
    }

    const path = resolved.pathname.toLowerCase();
    if (!path.includes("/post/")) continue;
    if (EXCLUDED_HREF_KEYWORDS.some((kw) => path.includes(kw))) continue;
    if (item.title.includes("?")) continue;

    const url = resolved.toString();
    if (seen.has(url)) continue;

    const candidate: NewsCandidate = {
      url,
      title: item.title,
      publishDate: item.publishDateText ? extractPublishDate(item.publishDateText) : null,
    };

    if (SCHEDULE_HREF_PATTERN.test(path)) {
      seen.add(url);
      tier1.push(candidate);
    } else if (TITLE_FALLBACK_KEYWORDS.some((kw) => item.title.toLowerCase().includes(kw))) {
      seen.add(url);
      tier2.push(candidate);
    }
  }

  return [...tier1, ...tier2].slice(0, limit);
}
