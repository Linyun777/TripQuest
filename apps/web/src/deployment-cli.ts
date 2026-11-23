import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pruneBilling, createJourneyDatabase, migrateJourneyDatabase } from "@tripquest/db";
import { validateProductionConfig } from "./app/deployment/config";
import { databaseReady } from "./app/deployment/health";

const root = resolve(import.meta.dirname, "../..");
const command = process.argv[2];

async function main() {
  if (command === "check") {
    await validateProductionConfig(process.env, root);
    return;
  }
  if (command === "health") {
    const response = await fetch("http://127.0.0.1:3000/api/health/ready", { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("Application not ready");
    return;
  }
  const client = createJourneyDatabase(process.env.DATABASE_URL ?? "", {
    applicationName: "tripquest-deploy",
    maxConnections: 1,
  });
  try {
    if (command === "prune-billing") {
      await pruneBilling(client.pool);
    } else if (command === "migrate") {
      await migrateJourneyDatabase(client.database, { migrationsFolder: resolve(root, "packages/db/drizzle") });
    } else if (command === "ready") {
      if (!await databaseReady(client.pool, root)) throw new Error("Database not ready");
    } else if (command === "drain") {
      const deadline = Date.now() + 600_000;
      while (true) {
        const result = await client.pool.query<{ n: number }>(
          `SELECT (SELECT count(*) FROM conversation_jobs WHERE status = 'running'
             AND heartbeat_at > now() - interval '90 seconds')::int +
            (SELECT count(*) FROM planning_tasks WHERE status IN ('queued', 'running'))::int AS n`,
        );
        if (result.rows[0]?.n === 0) return;
        if (Date.now() >= deadline) throw new Error("Tasks still active; maintenance remains enabled");
        await delay(2_000);
      }
    } else {
      throw new Error("Unknown deployment command");
    }
  } finally {
    await client.close();
  }
}

try {
  await main();
} catch {
  // Driver/profile errors may include configuration values. Keep operator output generic.
  console.error("Deployment check or operation failed; verify configuration, database and active tasks.");
  process.exitCode = 1;
}
