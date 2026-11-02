import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createJourneyDatabase } from "../connection";
import { requireSafeTestDatabaseUrl } from "../test-database-safety";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

/**
 * S6.1 acceptance asks for statement *and lock* timeouts (design §6, O-007).
 * The developer's timeout test covers the statement and client limits; this one
 * pins the pool-level `lock_timeout`, which must fire well before the 10s
 * statement limit so a blocked writer is never mistaken for a stalled query.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("O-007 lock timeout", () => {
  it("ends a blocked UPDATE with lock_not_available instead of waiting for the statement limit", async () => {
    const url = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    const client = createJourneyDatabase(url, { statementTimeoutMillis: 10_000 });
    try {
      await client.pool.query("DROP TABLE IF EXISTS s61_lock_probe");
      await client.pool.query("CREATE TABLE s61_lock_probe (id int PRIMARY KEY, n int NOT NULL)");
      await client.pool.query("INSERT INTO s61_lock_probe (id, n) VALUES (1, 0)");

      const holder = await client.pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("UPDATE s61_lock_probe SET n = 1 WHERE id = 1");
        const started = Date.now();
        await expect(
          client.pool.query("UPDATE s61_lock_probe SET n = 2 WHERE id = 1"),
          "the blocked writer is released by lock_timeout",
        ).rejects.toMatchObject({ code: "55P03" });
        const elapsed = Date.now() - started;
        expect(elapsed, "the 5s lock limit fires before the 10s statement limit").toBeGreaterThan(3_500);
        expect(elapsed).toBeLessThan(9_000);
        await holder.query("ROLLBACK");
      } finally {
        holder.release();
      }
      expect((await client.pool.query("SELECT n FROM s61_lock_probe WHERE id = 1")).rows[0].n, "the pool still works").toBe(0);
    } finally {
      await client.pool.query("DROP TABLE IF EXISTS s61_lock_probe").catch(() => {});
      await client.close();
    }
  }, 30_000);
});
