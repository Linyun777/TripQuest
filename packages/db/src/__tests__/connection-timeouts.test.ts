import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createJourneyDatabase } from "../connection";
import { requireSafeTestDatabaseUrl } from "../test-database-safety";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

describe.skipIf(!process.env.TEST_DATABASE_URL)("O-007 query limits", () => {
  it("ends an over-long statement on the server and an unanswered query on the client", async () => {
    const url = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    const server = createJourneyDatabase(url, { statementTimeoutMillis: 200, queryTimeoutMillis: 5_000 });
    const client = createJourneyDatabase(url, { statementTimeoutMillis: 5_000, queryTimeoutMillis: 200 });
    try {
      await expect(server.pool.query("SELECT pg_sleep(2)")).rejects.toMatchObject({ code: "57014" });
      // The client limit also covers a paused or unreachable server, where no reply ever comes.
      const started = Date.now();
      await expect(client.pool.query("SELECT pg_sleep(2)")).rejects.toThrow(/timeout/i);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect((await server.pool.query("SELECT 1 AS ok")).rows[0].ok, "pool still usable").toBe(1);
    } finally {
      await server.close();
      await client.close();
    }
  });
});
