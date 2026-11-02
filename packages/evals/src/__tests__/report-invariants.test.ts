import { describe, expect, it } from "vitest";

import { dataset } from "../cases/dataset";
import { planners } from "../planners";
import { runEvaluation } from "../runner";

// Expectations are hand derived from the S4.1 design: the one-minute boundary at
// E03/E04, the tool-assisted E05, the timeout that must not become zero at E06,
// the must-be-zero report counters, and run-to-run determinism.
const git = { sha: "independent-test", dirty: false as const };
const report = await runEvaluation(dataset, planners, { git });

function row(caseId: string, plannerId: "rules_only" | "fixed_workflow") {
  const found = report.rows.find((r) => r.caseId === caseId && r.plannerId === plannerId);
  if (!found) throw new Error(`missing ${caseId}/${plannerId}`);
  return found;
}

describe("S4.1 hand-derived case expectations", () => {
  it("E03 omits the adjustable activity and lands exactly on 18:00", () => {
    // 17:10 + 40 travel + 10 buffer = 18:00, exactly the reservation start.
    for (const plannerId of ["rules_only", "fixed_workflow"] as const) {
      const r = row("E03", plannerId);
      expect(r.finalStatus, `${plannerId} finds a candidate`).toBe("candidate_found");
      expect(r.selectedStrategy, `${plannerId} omits`).toBe("omit");
      expect(r.score.revalidation?.verdict, `${plannerId} revalidates feasible`).toBe("feasible");
      expect(r.score.revalidation?.checkedTransitions.at(-1)?.earliestArrivalAt, `${plannerId} arrives exactly at 18:00`).toBe("2026-10-15T18:00:00+08:00");
      expect(r.toolRequests, `${plannerId} needs no tool`).toBe(0);
      expect(r.score.failures).toEqual([]);
    }
  });

  it("E04 is one minute late and reports a bounded failure, not global impossibility", () => {
    // 17:11 + 40 + 10 = 18:01 > 18:00.
    for (const plannerId of ["rules_only", "fixed_workflow"] as const) {
      const r = row("E04", plannerId);
      expect(r.finalStatus, `${plannerId} has no feasible candidate`).toBe("no_feasible_candidate");
      expect(r.issueCodes, `${plannerId} names the conflict`).toContain("travel_conflict");
      expect(r.toolRequests, `${plannerId} does not reach for the tool`).toBe(0);
      expect(r.score.failures).toEqual([]);
    }
  });

  it("E05 shows the difference the tool actually makes", () => {
    const rules = row("E05", "rules_only");
    expect(rules.finalStatus, "rules alone cannot know C->D").toBe("needs_information");
    expect(rules.issueCodes).toContain("unknown_travel_duration");
    expect(rules.toolRequests, "rules_only never calls the tool").toBe(0);

    const fixed = row("E05", "fixed_workflow");
    expect(fixed.finalStatus, "one lookup unlocks the shift").toBe("candidate_found");
    expect(fixed.selectedStrategy).toBe("shift");
    expect(fixed.toolRequests, "exactly one lookup").toBe(1);
    expect(fixed.toolFailures, "and it succeeded").toBe(0);
    // 2400s -> 40 minutes; 16:30 + 40 + 10 = 17:20.
    expect(fixed.travelLegs.find((l) => l.fromPlaceId === "P-C" && l.toPlaceId === "P-D")?.duration, "the tool value is the ceiling of 2400/60").toEqual({ kind: "known", minutes: 40 });
    expect(fixed.score.revalidation?.checkedTransitions.at(-1)?.earliestArrivalAt, "arrives at 17:20").toBe("2026-10-15T17:20:00+08:00");
    expect(fixed.score.failures).toEqual([]);
  });

  it("E06 keeps the unknown after a timeout instead of filling in zero", () => {
    for (const plannerId of ["rules_only", "fixed_workflow"] as const) {
      const r = row("E06", plannerId);
      expect(r.finalStatus, `${plannerId} still lacks information`).toBe("needs_information");
      expect(r.issueCodes).toContain("unknown_travel_duration");
      expect(r.selectedStrategy, `${plannerId} selects nothing`).toBeNull();
      expect(r.travelLegs.find((l) => l.fromPlaceId === "P-C" && l.toPlaceId === "P-D"), `${plannerId} does not invent a minute value`).toBeUndefined();
    }
    const fixed = row("E06", "fixed_workflow");
    expect(fixed.toolRequests, "the failing lookup is still counted").toBe(1);
    expect(fixed.toolFailures, "and recorded as a failure").toBe(1);
    expect(fixed.score.failures).toEqual([]);
  });

  it("E07 refuses to borrow the reverse direction", () => {
    const r = row("E07", "fixed_workflow");
    expect(r.finalStatus, "still unknown").toBe("needs_information");
    expect(r.travelLegs.find((l) => l.fromPlaceId === "P-C" && l.toPlaceId === "P-D"), "no forward value appears").toBeUndefined();
    expect(r.travelLegs.find((l) => l.fromPlaceId === "P-D" && l.toPlaceId === "P-C"), "the original reverse fact survives").toBeDefined();
  });

  it("never calls the tool for the cases that need no route", () => {
    for (const caseId of ["E01", "E02", "E04", "E08", "E09", "E10", "E11", "E12"]) {
      for (const plannerId of ["rules_only", "fixed_workflow"] as const) {
        expect(row(caseId, plannerId).toolRequests, `${caseId}/${plannerId} makes zero requests`).toBe(0);
      }
    }
  });
});

describe("S4.1 report invariants", () => {
  it("has one row per case and planner and nothing failing", () => {
    expect(report.rows, "12 cases x 2 planners").toHaveLength(24);
    expect(report.rows.map((r) => r.caseId).filter((id, i, all) => all.indexOf(id) === i)).toHaveLength(12);
    expect(report.rows.filter((r) => !r.score.passed), "every row must pass its handwritten oracle").toEqual([]);
    expect(report.rows.filter((r) => r.finalStatus === "exception"), "no case may crash").toEqual([]);
  });

  it("keeps the two must-be-zero counters at zero", () => {
    expect(report.rows.filter((r) => r.score.selectedNonFeasible), "a selected candidate that revalidation rejects must never happen").toEqual([]);
    expect(report.rows.filter((r) => r.score.unsupportedFactChanges > 0), "a tool may not change facts without evidence").toEqual([]);
  });

  it("separates rules_only from fixed_workflow tool usage", () => {
    expect(report.rows.filter((r) => r.plannerId === "rules_only").every((r) => r.toolRequests === 0), "rules_only is tool-free by construction").toBe(true);
    const fixed = report.rows.filter((r) => r.plannerId === "fixed_workflow");
    expect(fixed.some((r) => r.toolRequests > 0), "fixed_workflow does use the tool where it matters").toBe(true);
    expect(report.rows.every((r) => r.toolRequests <= 3), "the budget is never exceeded").toBe(true);
  });

  it("reports honest counts rather than a single pass rate", () => {
    const candidates = report.rows.filter((r) => r.finalStatus === "candidate_found");
    expect(candidates.length, "candidates are counted per planner, not merged").toBeGreaterThan(0);
    const byStatus = new Map<string, number>();
    for (const r of report.rows) byStatus.set(r.finalStatus, (byStatus.get(r.finalStatus) ?? 0) + 1);
    // Hand counted from the design's per-case expectations: 7 candidates
    // (E01/E02/E03 both planners + E05 fixed), 9 needs_information
    // (E05 rules + E06/E07/E08/E09 both), 4 no_feasible (E04 + E12 both),
    // 2 request_not_current (E10), 2 unsupported_scenario (E11).
    expect(byStatus.get("candidate_found"), "3 rules_only + 3 fixed + E05 fixed").toBe(7);
    expect(byStatus.get("needs_information")).toBe(9);
    expect(byStatus.get("no_feasible_candidate"), "E04 + E12, both planners").toBe(4);
    expect(byStatus.get("request_not_current"), "E10 both planners").toBe(2);
    expect(byStatus.get("unsupported_scenario"), "E11 both planners").toBe(2);
    expect([...byStatus.values()].reduce((a, b) => a + b, 0), "every row is accounted for").toBe(24);
  });

  it("is deterministic apart from run identity and timing", async () => {
    const again = await runEvaluation(dataset, planners, { git });
    const strip = (rows: typeof report.rows) =>
      rows.map((row) => {
        const copy: Record<string, unknown> = { ...row };
        delete copy.elapsedMs;
        return copy;
      });
    expect(strip(again.rows), "business results, traces and scores repeat exactly").toEqual(strip(report.rows));
    expect(again.datasetHash, "the dataset digest is stable").toBe(report.datasetHash);
  });

  it("declares that no model and no external API were used", () => {
    expect(report.modelCalls, "no model is called in this stage").toBe(0);
    expect(report.modelTokens).toBe(0);
    expect(report.modelCost).toBe(0);
    expect(report.externalApiCalls, "no real Amap or other external call").toBe(0);
    expect(report.scope, "the scope disclaimer is carried in the report").toContain("no global-optimality claim");
  });

  it("records provenance without embedding answers in the digest input", () => {
    expect(report.datasetHash, "a content digest is present").toMatch(/^[0-9a-f]{64}$/);
    expect(report.git.sha).toBe("independent-test");
    expect(report.toolBudget, "the declared budget is the enforced one").toBe(3);
  });
});
