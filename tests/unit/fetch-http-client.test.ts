import { describe, expect, it } from "vitest";
import { FetchHttpClient } from "../../src/adapters/http/fetch-http-client";

const noopSleep = async (): Promise<void> => {};

describe("FetchHttpClient", () => {
  it("returns html on the first 200 response", async () => {
    let calls = 0;
    const client = new FetchHttpClient({
      sleepFn: noopSleep,
      fetchFn: async () => {
        calls++;
        return new Response("<html>ok</html>", { status: 200 });
      },
    });
    const res = await client.fetchHtml("https://hoe.com.ua/page/pogodinni-vidkljuchennja");
    expect(calls).toBe(1);
    expect(res).toEqual({
      ok: true,
      url: "https://hoe.com.ua/page/pogodinni-vidkljuchennja",
      status: 200,
      html: "<html>ok</html>",
    });
  });

  it("retries 503 and network failures and succeeds", async () => {
    let calls = 0;
    const client = new FetchHttpClient({
      maxRetries: 3,
      retryDelaysMs: [0, 0],
      sleepFn: noopSleep,
      fetchFn: async () => {
        calls++;
        if (calls === 1) throw new Error("ECONNRESET");
        if (calls === 2) return new Response("busy", { status: 503 });
        return new Response("<html>recovered</html>", { status: 200 });
      },
    });
    const res = await client.fetchHtml("https://hoe.com.ua/x");
    expect(calls).toBe(3);
    expect(res).toEqual({
      ok: true,
      url: "https://hoe.com.ua/x",
      status: 200,
      html: "<html>recovered</html>",
    });
  });

  it("does not retry 4xx client errors", async () => {
    for (const status of [404, 403]) {
      let calls = 0;
      const client = new FetchHttpClient({
        maxRetries: 3,
        sleepFn: noopSleep,
        fetchFn: async () => {
          calls++;
          return new Response("no", { status });
        },
      });
      const res = await client.fetchHtml("https://hoe.com.ua/missing");
      expect(calls).toBe(1);
      expect(res).toMatchObject({ ok: false, status, errorCode: "HTTP_4XX" });
    }
  });

  it("retries 429 and returns failure when all attempts fail", async () => {
    let calls = 0;
    const client = new FetchHttpClient({
      maxRetries: 3,
      retryDelaysMs: [0, 0],
      sleepFn: noopSleep,
      fetchFn: async () => {
        calls++;
        return new Response("slow down", { status: 429 });
      },
    });
    const res = await client.fetchHtml("https://hoe.com.ua/x");
    expect(calls).toBe(3);
    expect(res).toMatchObject({ ok: false, status: 429, errorCode: "HTTP_429" });
  });

  it("rejects empty response bodies", async () => {
    let calls = 0;
    const client = new FetchHttpClient({
      sleepFn: noopSleep,
      fetchFn: async () => {
        calls++;
        return new Response("   \n\t ", { status: 200 });
      },
    });
    const res = await client.fetchHtml("https://hoe.com.ua/x");
    expect(calls).toBe(1);
    expect(res).toMatchObject({ ok: false, status: 200, errorCode: "EMPTY_BODY" });
  });
});
