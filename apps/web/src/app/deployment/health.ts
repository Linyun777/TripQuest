import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getSharedJourneyDatabase } from "@tripquest/db";
import { validateProductionConfig } from "./config";

export interface HealthDatabase {
  query(text: string): Promise<{ rows: { hash: string }[] }>;
}

/** A read-only comparison with the shipped migration files; no migration runs on requests. */
export async function databaseReady(
  database: HealthDatabase = getSharedJourneyDatabase().pool,
  workspaceRoot = resolve(process.cwd(), "../.."),
): Promise<boolean> {
  const folder = resolve(workspaceRoot, "packages/db/drizzle");
  const journal = JSON.parse(await readFile(resolve(folder, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const { createHash } = await import("node:crypto");
  const expected = await Promise.all(journal.entries.map(async ({ tag }) =>
    createHash("sha256").update(await readFile(resolve(folder, `${tag}.sql`), "utf8")).digest("hex"),
  ));
  const { rows } = await database.query("SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id");
  return rows.length === expected.length && rows.every((row, index) => row.hash === expected[index]);
}

export function createReadyHandler(check: () => Promise<boolean> = async () => {
  await validateProductionConfig();
  return databaseReady();
}) {
  return async (): Promise<Response> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        check(),
        new Promise<false>((done) => { timer = setTimeout(() => done(false), 4_000); }),
      ]);
      return healthResponse(ready ? 200 : 503);
    } catch {
      return healthResponse(503);
    } finally {
      clearTimeout(timer);
    }
  };
}

export function healthResponse(status: 200 | 503): Response {
  return Response.json({ status: status === 200 ? "ok" : "unavailable" }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
