import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const FIXTURES_DIR = path.join(import.meta.dirname, "..", "fixtures", "html");
const FIXTURES = [
  "main_page.html",
  "news_page.html",
  "news_post_2026-11-25.html",
  "news_post_2026-11-26.html",
  "news_post_2026-11-27.html",
];

describe("fixtures", () => {
  it.each(FIXTURES)("%s exists and is non-empty", (name) => {
    expect(statSync(path.join(FIXTURES_DIR, name)).size).toBeGreaterThan(10_000);
  });

  it("main_page.html contains div.content-main > div.post via cheerio", () => {
    const html = readFileSync(path.join(FIXTURES_DIR, "main_page.html"), "utf8");
    const $ = cheerio.load(html);
    expect($("main.page div.content-main > div.post")).toHaveLength(1);
  });
});

describe("zod v4", () => {
  it("validates a compact interval tuple with jitless mode", () => {
    z.config({ jitless: true });
    const interval = z.tuple([z.number().int().min(0).max(1440), z.number().int().min(0).max(1440)]);
    expect(interval.parse([360, 480])).toEqual([360, 480]);
    expect(interval.safeParse([360, 2000]).success).toBe(false);
  });
});
