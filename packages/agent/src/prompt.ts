import type { DecisionContext } from "./contracts";
import { LIMITS, DecisionModelError } from "./contracts";

export const PROMPT_VERSION = "route-investigation-v1";
export const SYSTEM_PROMPT = `You investigate missing directed walking routes for a one-day plan.
Return exactly one JSON object, no prose or private reasoning:
{"action":"lookup_route","fromPlaceId":"...","toPlaceId":"..."}
or {"action":"finish","reasonCode":"sufficient_information"|"cannot_resolve"}.
Only query a direction in allowedEdges. Never repeat a query or overwrite known facts.
Prefer keeping the ordinary activity (keep/shift) over omitting it when retention can still be proved.
A feasible omit alone is not enough to stop if a retaining strategy still has unknown routes.
Use the full attempts: a known violation or outside_scope/would_reorder prevents that strategy;
an unknown issue in a different attempt does not undo a known violation.
If retention is already impossible, investigate the direct route to the reservation.
Route failures remain unknown; you may investigate another unrequested route.
You cannot change times, plans, reservations, progress, budgets, or provider configuration.
Program code computes feasibility and candidates. Do not invent route values.`;

export function serializeContext(context: DecisionContext): string {
  const content = JSON.stringify(context);
  if (content.length > LIMITS.contextChars) throw new DecisionModelError("context_limit");
  return content;
}

export const FEEDBACK_PROMPT_VERSION = "route-investigation-feedback-v1";
export const FEEDBACK_SYSTEM_PROMPT = SYSTEM_PROMPT + `
The program may supply one action-feedback-v1 feedback after rejecting a route choice.
That rejected action did not execute a tool or change facts. Correct the choice using
only current allowedEdges and remaining budgets. No more than one repair is allowed.`;
