import { hostname } from "node:os";
import { createJourneyDatabase, PgPlanningTaskRepository } from "@tripquest/db";
import { PlanningFixtureProvider } from "@tripquest/providers/planning-fixture";
import { createPostgresCheckpointer } from "./checkpointer";
import { runWorker } from "./loop";

/** Entry point: `node --env-file-if-exists=../../.env dist/worker.js`. */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const client = createJourneyDatabase(url, {
  applicationName: "tripquest-worker",
  maxConnections: 6,
  statementTimeoutMillis: 15_000,
  queryTimeoutMillis: 20_000,
});
const checkpointer = await createPostgresCheckpointer(client.pool);
const owner = `${hostname()}:${process.pid}`;
// Development-only knob for crash/resume checks: slows every fixture call. Ignored in production.
const delayMs = process.env.NODE_ENV === "production" ? 0 : Number(process.env.WORKER_FIXTURE_DELAY_MS ?? 0);
const fixture = new PlanningFixtureProvider(Date.now);
const pause = () => new Promise((resolve) => setTimeout(resolve, delayMs));
const provider = delayMs > 0
  ? {
      searchPlaces: async (...args: Parameters<typeof fixture.searchPlaces>) => {
        await pause();
        return fixture.searchPlaces(...args);
      },
      findRoutes: async (...args: Parameters<typeof fixture.findRoutes>) => {
        await pause();
        return fixture.findRoutes(...args);
      },
    }
  : undefined;
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown.abort());
}
console.log(`TripQuest worker ${owner} started`);
await runWorker({
  repository: new PgPlanningTaskRepository(client.pool, "worker"),
  checkpointer,
  owner,
  ...(provider ? { provider } : {}),
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  log: (line) => console.log(line),
}, shutdown.signal);
await client.close();
console.log("TripQuest worker stopped");
