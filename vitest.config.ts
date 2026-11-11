import { defineConfig } from "vitest/config";

// Plain Node tests (no Nuxt runtime): the tested code avoids auto-imports.
// `pnpm test` runs tests/unit; `pnpm test:integration` needs Mongo (docker compose up -d).
export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
    },
});
