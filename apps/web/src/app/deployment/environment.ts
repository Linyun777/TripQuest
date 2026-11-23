/** Real data stays opt-in; an invited deployment does not open the development labs. */
export function permitsRealPlanning(environment: NodeJS.ProcessEnv): boolean {
  const mode = environment.TRIPQUEST_DEPLOYMENT_MODE ?? "local";
  return (environment.NODE_ENV === "development" && mode === "local") ||
    (environment.NODE_ENV === "production" && mode === "invited");
}
