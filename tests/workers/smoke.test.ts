import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("D1 migrations", () => {
  it("creates all expected tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const table of ["days", "day_revisions", "api_snapshots", "sync_state", "scrape_runs"]) {
      expect(names).toContain(table);
    }
  });
});

describe("HTMLRewriter", () => {
  it("extracts h1 text from a streamed response", async () => {
    let text = "";
    const rewriter = new HTMLRewriter().on("h1", {
      text(chunk) {
        text += chunk.text;
      },
    });
    const response = rewriter.transform(
      new Response("<html><body><h1>Погодинні відключення</h1></body></html>"),
    );
    await response.text();
    expect(text).toBe("Погодинні відключення");
  });
});

describe("zod v4 in workerd", () => {
  it("validates without EvalError", () => {
    z.config({ jitless: true });
    const schema = z.object({ start: z.number().int(), end: z.number().int() });
    expect(schema.parse({ start: 360, end: 480 })).toEqual({ start: 360, end: 480 });
  });
});

describe("worker entrypoint", () => {
  it("GET /health returns ok", async () => {
    const response = await exports.default.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      dbReady: true,
      lastOutcome: null,
      lastSuccessAt: null,
      lastCheckedAt: null,
      consecutiveFailures: 0,
    });
  });

  it("unknown route returns 404", async () => {
    const response = await exports.default.fetch("https://example.com/nope");
    expect(response.status).toBe(404);
  });
});
