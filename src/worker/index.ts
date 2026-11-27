import { z } from "zod";
import type { WorkerEnv } from "./env";
import { handleHttpRequest } from "./http-handler";
import { handleScheduled } from "./scheduled-handler";

// Cloudflare Workers forbid `new Function()` / eval at request time.
z.config({ jitless: true });

export default {
  fetch(request, env): Promise<Response> {
    return handleHttpRequest(request, env);
  },

  scheduled(controller, env, ctx): void {
    ctx.waitUntil(handleScheduled(controller, env));
  },
} satisfies ExportedHandler<WorkerEnv>;
