import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    test: {
      exclude: ["legacy/**", "node_modules/**"],
      projects: [
        {
          test: {
            name: "unit",
            environment: "node",
            include: ["tests/unit/**/*.test.ts"],
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: { TEST_MIGRATIONS: migrations },
              },
            }),
          ],
          test: {
            name: "workers",
            include: ["tests/workers/**/*.test.ts"],
            setupFiles: ["./tests/workers/setup-migrations.ts"],
          },
        },
      ],
    },
  };
});
