import type { ExtractedNewsListing, ExtractedSchedulePage } from "../types/extracted";

/**
 * Parser-agnostic HTML extraction port. Implementations must return
 * entity-decoded, BOM-free, NBSP-normalised text.
 */
export interface HtmlExtractor {
  extractSchedulePage(html: string, url: string): Promise<ExtractedSchedulePage>;
  extractNewsListing(html: string, url: string): Promise<ExtractedNewsListing>;
}
