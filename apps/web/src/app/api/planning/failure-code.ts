import "server-only";

/**
 * In development only: what kind of error ended a save, never its content (AGENTS §5). Enough
 * to tell a database conflict, a provider timeout and a broken invariant apart next time.
 */
export function logFailure(where: string, error: unknown, environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.NODE_ENV !== "development") return;
  const name = error instanceof Error ? error.name : typeof error;
  const code = typeof error === "object" && error && "code" in error && typeof error.code === "string" ? error.code : "-";
  // Our own invariant messages are fixed English phrases; anything longer is cut.
  const message = error instanceof Error ? error.message.split("\n")[0].slice(0, 60) : "";
  console.warn(`[${where}] failed: ${name} ${code} ${message}`);
}
