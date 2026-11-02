import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import { schema } from "./schema";

export type JourneyDatabase = NodePgDatabase<typeof schema>;

export interface JourneyDatabaseClient {
  readonly database: JourneyDatabase;
  readonly pool: Pool;
  close(): Promise<void>;
}

export interface JourneyDatabaseOptions {
  readonly applicationName?: string;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
  readonly maxConnections?: number;
  /** Server-side limit for one statement (O-007). */
  readonly statementTimeoutMillis?: number;
  /** Client-side limit; also ends a query on a paused or unreachable server (O-007). */
  readonly queryTimeoutMillis?: number;
  /** Called for disconnected idle clients. It must not expose secrets to users. */
  readonly onPoolError?: (error: Error) => void;
}

interface SharedJourneyDatabaseState {
  readonly connectionString: string;
  readonly client: JourneyDatabaseClient;
}

const sharedGlobal = globalThis as typeof globalThis & {
  __tripquestJourneyDatabase?: SharedJourneyDatabaseState;
};

export function createJourneyDatabase(
  connectionString: string,
  options: JourneyDatabaseOptions = {},
): JourneyDatabaseClient {
  const normalizedConnectionString = requireConnectionString(connectionString);
  const poolConfig: PoolConfig = {
    connectionString: normalizedConnectionString,
    application_name: options.applicationName ?? "tripquest",
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    max: options.maxConnections ?? 10,
    // O-007: no statement, lock wait or idle transaction may hang a request indefinitely.
    statement_timeout: options.statementTimeoutMillis ?? 10_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
    query_timeout: options.queryTimeoutMillis ?? 15_000,
  };
  const pool = new Pool(poolConfig);
  pool.on("error", (error) => {
    try {
      options.onPoolError?.(error);
    } catch {
      return;
    }
  });
  const database = drizzle(pool, { schema });
  let closePromise: Promise<void> | undefined;

  return {
    database,
    pool,
    close() {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}

/**
 * Reuses one lazy pg Pool across Next.js development module reloads. Calling this
 * function does not connect to PostgreSQL until a query is executed.
 */
export function getSharedJourneyDatabase(
  connectionString: string | undefined = process.env.DATABASE_URL,
): JourneyDatabaseClient {
  const normalizedConnectionString = requireConnectionString(connectionString);
  const existing = sharedGlobal.__tripquestJourneyDatabase;

  if (existing !== undefined) {
    if (existing.connectionString !== normalizedConnectionString) {
      throw new Error(
        "TripQuest shared database is already configured for another connection",
      );
    }
    return existing.client;
  }

  const client = createJourneyDatabase(normalizedConnectionString, {
    applicationName: "tripquest-web",
  });
  sharedGlobal.__tripquestJourneyDatabase = {
    connectionString: normalizedConnectionString,
    client,
  };
  return client;
}

export async function closeSharedJourneyDatabase(): Promise<void> {
  const existing = sharedGlobal.__tripquestJourneyDatabase;
  if (existing === undefined) return;

  delete sharedGlobal.__tripquestJourneyDatabase;
  await existing.client.close();
}

function requireConnectionString(value: string | undefined): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    throw new Error("DATABASE_URL is required to access TripQuest PostgreSQL");
  }
  return normalized;
}
