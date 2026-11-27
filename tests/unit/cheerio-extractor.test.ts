import { describeExtractorParity } from "../fixtures/parity-cases";
import { CheerioHtmlExtractor } from "../../src/adapters/html/cheerio-extractor";

describeExtractorParity("CheerioHtmlExtractor", () => new CheerioHtmlExtractor());
