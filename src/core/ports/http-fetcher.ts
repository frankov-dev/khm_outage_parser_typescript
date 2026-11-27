export type FetchHtmlResult =
  | { ok: true; url: string; status: number; html: string }
  | {
      ok: false;
      url: string;
      status: number | null;
      errorCode: string;
      errorMessage: string;
    };

export interface HttpFetcher {
  fetchHtml(url: string): Promise<FetchHtmlResult>;
}
