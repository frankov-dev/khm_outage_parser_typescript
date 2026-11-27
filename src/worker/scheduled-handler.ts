import { HtmlRewriterExtractor } from "../adapters/html/html-rewriter-extractor";
import { FetchHttpClient } from "../adapters/http/fetch-http-client";
import { D1ScheduleRepository } from "../adapters/storage/d1-schedule-repository";
import { SyncOrchestrator } from "../core/pipeline/sync-orchestrator";
import type { Clock } from "../core/ports/clock";
import type { HttpFetcher } from "../core/ports/http-fetcher";
import { SystemKyivClock } from "../core/time/kyiv-clock";
import type { SyncResult } from "../core/types/domain";
import type { WorkerEnv } from "./env";

export interface ScheduledHandlerDeps {
  fetcher?: HttpFetcher;
  clock?: Clock;
}

export async function handleScheduled(
  _controller: ScheduledController,
  env: WorkerEnv,
  deps: ScheduledHandlerDeps = {},
): Promise<SyncResult> {
  const orchestrator = new SyncOrchestrator(
    deps.fetcher ?? new FetchHttpClient(),
    new HtmlRewriterExtractor(),
    new D1ScheduleRepository(env.DB),
    deps.clock ?? new SystemKyivClock(),
  );
  const result = await orchestrator.runSync();
  console.log(JSON.stringify({ event: "cron_sync", ...result }));
  return result;
}
