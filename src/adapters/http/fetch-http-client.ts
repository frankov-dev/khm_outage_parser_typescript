import type { FetchHtmlResult, HttpFetcher } from "../../core/ports/http-fetcher";

export interface FetchHttpClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
  retryDelaysMs?: readonly number[];
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7",
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class FetchHttpClient implements HttpFetcher {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: FetchHttpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelaysMs = options.retryDelaysMs ?? [500, 1500];
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.sleepFn = options.sleepFn ?? defaultSleep;
  }

  async fetchHtml(url: string): Promise<FetchHtmlResult> {
    let lastFailure: FetchHtmlResult = {
      ok: false,
      url,
      status: null,
      errorCode: "FETCH_FAILED",
      errorMessage: "No fetch attempts executed",
    };

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      let retryable = false;

      try {
        const response = await this.fetchFn(url, {
          headers: DEFAULT_HEADERS,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!response.ok) {
          const retry = shouldRetryStatus(response.status);
          const errorCode = response.status === 429 ? "HTTP_429" : response.status >= 500 ? "HTTP_5XX" : "HTTP_4XX";
          lastFailure = {
            ok: false,
            url,
            status: response.status,
            errorCode,
            errorMessage: `HTTP ${response.status}`,
          };
          if (!retry) return lastFailure;
          retryable = true;
        } else {
          const html = await response.text();
          if (html.trim().length === 0) {
            return {
              ok: false,
              url,
              status: response.status,
              errorCode: "EMPTY_BODY",
              errorMessage: "Response body is empty",
            };
          }
          return { ok: true, url, status: response.status, html };
        }
      } catch (err) {
        const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
        lastFailure = {
          ok: false,
          url,
          status: null,
          errorCode: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
          errorMessage: err instanceof Error ? err.message : String(err),
        };
        retryable = true;
      }

      if (retryable && attempt < this.maxRetries) {
        const delay = this.retryDelaysMs[attempt - 1] ?? this.retryDelaysMs[this.retryDelaysMs.length - 1] ?? 500;
        if (delay > 0) await this.sleepFn(delay);
      }
    }

    return lastFailure;
  }
}
