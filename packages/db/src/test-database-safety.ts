export function requireSafeTestDatabaseUrl(
  testDatabaseUrl: string | undefined,
  developmentDatabaseUrl: string | undefined,
): string {
  const normalizedTestUrl = normalizePostgresUrl(
    testDatabaseUrl,
    "TEST_DATABASE_URL is required for database integration tests",
  );
  const testDatabaseName = decodeURIComponent(
    new URL(normalizedTestUrl).pathname.slice(1),
  );

  if (!testDatabaseName.endsWith("_test")) {
    throw new Error("TEST_DATABASE_URL must target a database ending in _test");
  }

  if (developmentDatabaseUrl !== undefined && developmentDatabaseUrl.trim() !== "") {
    const normalizedDevelopmentUrl = normalizePostgresUrl(
      developmentDatabaseUrl,
      "DATABASE_URL is invalid",
    );
    if (
      databaseTarget(normalizedDevelopmentUrl) ===
      databaseTarget(normalizedTestUrl)
    ) {
      throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL");
    }
  }

  return normalizedTestUrl;
}

function databaseTarget(value: string): string {
  const parsed = new URL(value);
  const port = parsed.port === "" ? "5432" : parsed.port;
  return `${parsed.hostname.toLowerCase()}:${port}${parsed.pathname}`;
}

function normalizePostgresUrl(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    throw new Error(message);
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(message);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(message);
  }
  if (parsed.pathname.length <= 1) {
    throw new Error(message);
  }
  return parsed.toString();
}
