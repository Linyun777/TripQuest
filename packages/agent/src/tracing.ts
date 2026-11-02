/** Prevent environment-driven external callbacks, including legacy LangChain tracing. */
export function assertLocalTracingOnly(): void {
  const flags = ["LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING", "LANGCHAIN_VERBOSE"];
  if (flags.some((key) => process.env[key] && process.env[key] !== "false")) {
    throw new Error("External tracing must be disabled for TripQuest evaluation");
  }
  // The legacy flag is interpreted by upstream as a truthy string, even "false".
  if (process.env.LANGCHAIN_TRACING) {
    throw new Error("Unset legacy LANGCHAIN_TRACING for evaluation");
  }
}
