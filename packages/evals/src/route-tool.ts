import type { ProviderEvidence, RouteResult } from "@tripquest/providers";
import { TOOL_BUDGET, type LookupRoute, type RouteWorldEntry, type ToolCall } from "./contracts";

export const edgeKey = (from: string, to: string): string => JSON.stringify([from, to]);
/** Only this closure sees the world. Results and trace are separately owned. */
export function createRouteTool(world: readonly RouteWorldEntry[], evidence: ProviderEvidence) {
  const table = new Map(world.map((e) => [edgeKey(e.fromPlaceId, e.toPlaceId), structuredClone(e.result)]));
  const trace: ToolCall[] = [];
  let closed = false;
  const lookupRoute: LookupRoute = async (fromPlaceId, toPlaceId) => {
    if (closed) throw new Error("Tool instance is closed");
    const invalid = typeof fromPlaceId !== "string" || !fromPlaceId || typeof toPlaceId !== "string" || !toPlaceId;
    const result = trace.length >= TOOL_BUDGET ? { status: "budget_exhausted" as const }
      : invalid ? { status: "failure", failure: { code: "invalid_request", retry: "never", safeMessage: "Invalid synthetic route arguments" }, evidence: structuredClone(evidence) } satisfies RouteResult
      : table.get(edgeKey(fromPlaceId, toPlaceId)) ?? { status: "no_route", reason: "no_path", evidence: structuredClone(evidence) } satisfies RouteResult;
    trace.push({ sequence: trace.length + 1, fromPlaceId, toPlaceId, result: structuredClone(result) });
    return structuredClone(result);
  };
  return { lookupRoute, snapshot: () => structuredClone(trace), close: () => { closed = true; } };
}
