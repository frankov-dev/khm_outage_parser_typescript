import { D1ScheduleRepository } from "../adapters/storage/d1-schedule-repository";
import { parseDateIso } from "../core/time/kyiv-clock";
import type { ApiHealthResponse } from "../core/types/api";
import { ALL_SUBQUEUES, type SubqueueId } from "../core/types/domain";
import type { WorkerEnv } from "./env";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "If-None-Match",
};

const SNAPSHOT_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function etagMatches(headerValue: string | null, expectedEtag: string): boolean {
  if (!headerValue) return false;
  return headerValue
    .split(",")
    .map((part) => part.trim().replace(/^W\//i, "").replace(/^"(.*)"$/, "$1"))
    .some((tag) => tag === "*" || tag === expectedEtag);
}

async function serveSnapshot(
  repo: D1ScheduleRepository,
  key: string,
  request: Request,
  missingStatus: 404 | 503,
  missingMessage: string,
): Promise<Response> {
  const snap = await repo.getSnapshot(key);
  if (!snap) {
    return jsonResponse({ error: missingMessage }, missingStatus, { "Cache-Control": "no-store" });
  }

  const quotedEtag = `"${snap.etag}"`;
  if (etagMatches(request.headers.get("If-None-Match"), snap.etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: quotedEtag,
        "Cache-Control": SNAPSHOT_CACHE_CONTROL,
        ...CORS_HEADERS,
      },
    });
  }

  return new Response(snap.body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ETag: quotedEtag,
      "Cache-Control": SNAPSHOT_CACHE_CONTROL,
      ...CORS_HEADERS,
    },
  });
}

export async function handleHttpRequest(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method Not Allowed" }, 405, { Allow: "GET, OPTIONS" });
  }

  const pathname = new URL(request.url).pathname;
  const repo = new D1ScheduleRepository(env.DB);

  if (pathname === "/health") {
    await repo.ping();
    const state = await repo.getSyncState();
    const consecutiveFailures = state?.consecutiveFailures ?? 0;
    const health: ApiHealthResponse = {
      status: consecutiveFailures >= 3 ? "degraded" : "ok",
      dbReady: true,
      lastOutcome: state?.lastOutcome ?? null,
      lastSuccessAt: state?.lastSuccessAt ?? null,
      lastCheckedAt: state?.lastCheckedAt ?? null,
      consecutiveFailures,
    };
    return jsonResponse(health, 200, { "Cache-Control": "no-store" });
  }

  if (pathname === "/api/current") {
    return serveSnapshot(repo, "current", request, 503, "No schedule data available yet");
  }
  if (pathname === "/api/status") {
    return serveSnapshot(repo, "status", request, 503, "No schedule data available yet");
  }
  if (pathname === "/api/schedules") {
    return serveSnapshot(repo, "history", request, 503, "No schedule data available yet");
  }

  if (pathname.startsWith("/api/schedules/")) {
    const dateParam = pathname.slice("/api/schedules/".length);
    if (parseDateIso(dateParam) === null) {
      return jsonResponse({ error: "Invalid date format, expected YYYY-MM-DD" }, 400);
    }
    return serveSnapshot(repo, `day:${dateParam}`, request, 404, "Schedule not found");
  }

  if (pathname.startsWith("/api/queues/")) {
    const queueParam = pathname.slice("/api/queues/".length);
    if (!(ALL_SUBQUEUES as readonly string[]).includes(queueParam)) {
      return jsonResponse({ error: "Invalid subqueue id, expected 1.1..6.2" }, 400);
    }
    return serveSnapshot(
      repo,
      `queue:${queueParam as SubqueueId}`,
      request,
      503,
      "No schedule data available yet",
    );
  }

  return jsonResponse({ error: "Not Found" }, 404);
}
