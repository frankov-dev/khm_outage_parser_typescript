import type { DateIso } from "./domain";

/** A `<hr>`-delimited section of the schedule container. */
export interface ExtractedSection {
  lines: string[];
  imageAlts: string[];
}

export interface ExtractedSchedulePage {
  url: string;
  heading: string | null;
  publishDateText: string | null;
  hasExpectedContainer: boolean;
  sections: ExtractedSection[];
}

export interface ExtractedNewsItem {
  href: string;
  title: string;
  publishDateText: string | null;
}

export interface ExtractedNewsListing {
  url: string;
  items: ExtractedNewsItem[];
}

export type DateSource = "text" | "image_alt" | "publish_context" | "fallback_today";

export interface RawScheduleBlock {
  date: DateIso;
  dateSource: DateSource;
  scheduleText: string;
  extrasText: string;
  sourceUrl: string;
}
