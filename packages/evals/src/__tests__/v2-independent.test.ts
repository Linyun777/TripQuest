import { describe, expect, it } from "vitest";
import type { BaselinePlanningInput, ChinaDateTime, PlannedActivity } from "@tripquest/domain";
import { generateBaselineCandidate } from "@tripquest/domain";
import { accessibleEdges, edgeKey as agentEdgeKey, LIMITS } from "@tripquest/agent";
import type { RouteResult } from "@tripquest/providers";
import { runV2 } from "../v2/runner";
import type { V2Row } from "../v2/runner";
import { runAdaptive } from "../v2/adaptive";
import { datasetV2, V2_IDS } from "../v2/dataset";
import { dataset, FIXTURE_EVIDENCE } from "../cases/dataset";
import { missingRouteEdges } from "../planners";
import { edgeKey as toolEdgeKey } from "../route-tool";
import { datasetHash } from "../dataset-validation";

const git = { sha: "independent-test", dirty: true };

const at = (time: string): ChinaDateTime => `2026-10-15T${time}:00+08:00`;
const minutes = (seconds: number) => Math.ceil(seconds / 60);
const allowedKeys = (input: BaselinePlanningInput) => accessibleEdges(input).map((e) => agentEdgeKey(e));
const missingKeys = (input: BaselinePlanningInput) =>
  missingRouteEdges(input).map(([from, to]) => toolEdgeKey(from, to));
const caseOf = (id: string) => {
  const entry = datasetV2.cases.find((c) => c.id === id);
  if (!entry) throw new Error(`missing case ${id}`);
  return entry;
};

function routeSeconds(result: RouteResult): number {
  if (result.status !== "ok" || result.routes.length !== 1) throw new Error("expected exactly one route");
  return result.routes[0].durationSeconds;
}

/** Design §6 world, read straight from the authored fixture, not from a planner. */
function worldSeconds(caseId: string, from: string, to: string): number {
  const entry = caseOf(caseId).world.find((w) => w.fromPlaceId === from && w.toPlaceId === to);
  if (!entry) throw new Error(`${caseId} has no authored ${from}->${to}`);
  return routeSeconds(entry.result);
}

function withActivity(
  activities: readonly PlannedActivity[],
  id: string,
  patch: Partial<PlannedActivity>,
): PlannedActivity[] {
  return activities.map((a) => (a.id === id ? { ...a, ...patch } : { ...a }));
}

const edgesOf = (row: V2Row) => row.trace.map((t) => [t.fromPlaceId, t.toPlaceId]);
const rowOf = (rows: readonly V2Row[], caseId: string, plannerId: string) => {
  const row = rows.find((r) => r.caseId === caseId && r.plannerId === plannerId);
  if (!row) throw new Error(`missing row ${caseId}/${plannerId}`);
  return row;
};

describe("four strategies share one world, one budget and one allowed direction set", () => {
  it("derives exactly the same allowed directions in both independent implementations", () => {
    const base = datasetV2.cases[0].input;
    // The authored E01 input already knows P-C->P-D, which masks the only
    // remaining edge; an input with no known legs is needed to discriminate.
    const openBase: BaselinePlanningInput = { ...base, travelLegs: [] };
    const variants: readonly [string, BaselinePlanningInput][] = [
      ["as authored", base],
      ["unknown location", { ...base, state: { ...base.state, location: { kind: "unknown" } } }],
      ["activity in progress", { ...base, state: { ...base.state, currentActivityId: "C" } }],
      ["pending reservation", {
        ...base,
        reservations: base.reservations.map((r) => ({
          ...r,
          confirmation: { ...r.confirmation, status: "pending" as const },
        })),
      }],
      ["rest_of_day scope", {
        ...base,
        request: { ...base.request, scope: { kind: "rest_of_day" as const, from: at("15:00") } },
      }],
      ["target outside the window", {
        ...base,
        request: {
          ...base.request,
          scope: { kind: "selected_window", window: { startsAt: at("16:00"), endsAt: at("18:00") } },
        },
      }],
      ["target locked", {
        ...openBase,
        plan: { ...openBase.plan, activities: withActivity(openBase.plan.activities, "C", { locked: true }) },
      }],
      ["target already carries a reservation", {
        ...openBase,
        plan: {
          ...openBase.plan,
          activities: withActivity(openBase.plan.activities, "C", { reservationId: "R-C" }),
        },
      }],
      ["reservation activity unlocked", {
        ...openBase,
        plan: { ...openBase.plan, activities: withActivity(openBase.plan.activities, "D", { locked: false }) },
      }],
      ["one known edge", {
        ...base,
        travelLegs: [{ fromPlaceId: "P-C", toPlaceId: "P-D", duration: { kind: "known" as const, minutes: 40 } }],
      }],
      ["observation at the reservation", {
        ...base,
        state: { ...base.state, location: { kind: "known" as const, placeId: "P-D" } },
      }],
    ];
    for (const [label, input] of variants) {
      expect(allowedKeys(input), label).toEqual(missingKeys(input));
    }
    for (const c of datasetV2.cases) {
      expect(allowedKeys(c.input), c.id).toEqual(missingKeys(c.input));
    }
  });

  it("serves every planner the fixture world and nothing else", async () => {
    const report = await runV2({ git });
    expect(report.rows).toHaveLength(datasetV2.cases.length * V2_IDS.length);
    for (const row of report.rows) {
      const entry = caseOf(row.caseId);
      const world = new Map(entry.world.map((w) => [toolEdgeKey(w.fromPlaceId, w.toPlaceId), w.result]));
      const allowed = new Set(allowedKeys(entry.input));
      expect(row.trace.length, `${row.caseId}/${row.plannerId} tool budget`).toBeLessThanOrEqual(LIMITS.routes);
      for (const call of row.trace) {
        const key = toolEdgeKey(call.fromPlaceId, call.toPlaceId);
        expect(allowed.has(key), `${row.caseId}/${row.plannerId} illegal ${key}`).toBe(true);
        const authored = world.get(key);
        if (authored) expect(call.result, `${row.caseId}/${row.plannerId} ${key}`).toEqual(authored);
        else expect(call.result, `${row.caseId}/${row.plannerId} ${key}`).toMatchObject({ status: "no_route" });
      }
      const requested = row.trace.map((c) => toolEdgeKey(c.fromPlaceId, c.toPlaceId));
      expect(new Set(requested).size, `${row.caseId}/${row.plannerId} repeats`).toBe(requested.length);
      expect(row.output?.routeRequests).toBe(row.trace.length);
    }
  });

  it("keeps the rule-based strategy free of tool and model calls and honours zero-tool cases", async () => {
    const report = await runV2({ git });
    for (const row of report.rows) {
      if (row.plannerId === "rules_only") expect(row.trace, `${row.caseId} rules`).toEqual([]);
      if (caseOf(row.caseId).execution.requireZeroTools) {
        expect(row.trace, `${row.caseId}/${row.plannerId} tools`).toEqual([]);
        expect(row.output?.modelRequests, `${row.caseId}/${row.plannerId} models`).toBe(0);
      }
    }
  });

  it("records the scripted model as a mirror of the deterministic adaptive flow", async () => {
    const report = await runV2({ git });
    for (const c of datasetV2.cases) {
      const adaptive = rowOf(report.rows, c.id, "adaptive_workflow");
      const scripted = rowOf(report.rows, c.id, "model_agent");
      expect(edgesOf(scripted), c.id).toEqual(edgesOf(adaptive));
      expect(scripted.output?.result.status, c.id).toBe(adaptive.output?.result.status);
      expect(scripted.modelMode).toBe("scripted");
    }
  });
});

describe("E13/E14 human oracles are re-derived from the fixture numbers", () => {
  it("recomputes the E13 retention schedule and the E14 direct arrival by hand", () => {
    const e13 = caseOf("E13");
    expect(minutes(worldSeconds("E13", "P-B", "P-C"))).toBe(10);
    expect(minutes(worldSeconds("E13", "P-C", "P-D"))).toBe(20);
    expect(minutes(worldSeconds("E13", "P-B", "P-D"))).toBe(50);
    const buffer = e13.input.transferBufferMinutes;
    const resume = e13.input.request.delay.earliestResumeAt;
    expect(Date.parse(resume) + (10 + buffer) * 60_000).toBe(Date.parse(at("15:50")));
    expect(Date.parse(at("16:50")) + (20 + buffer) * 60_000).toBe(Date.parse(at("17:20")));
    const expected13 = e13.expected.adaptive_workflow;
    expect(expected13.strategy).toBe("shift");
    expect(expected13.arrival?.at).toBe(at("17:20"));
    expect(expected13.activities).toEqual(withActivity(e13.input.plan.activities, "C", {
      startsAt: at("15:50"),
      endsAt: at("16:50"),
    }));

    const e14 = caseOf("E14");
    expect(minutes(worldSeconds("E14", "P-B", "P-D"))).toBe(40);
    expect(Date.parse(e14.input.request.delay.earliestResumeAt) + (40 + e14.input.transferBufferMinutes) * 60_000)
      .toBe(Date.parse(at("18:00")));
    const expected14 = e14.expected.adaptive_workflow;
    expect(expected14.strategy).toBe("omit");
    expect(expected14.arrival?.at).toBe(at("18:00"));
    expect(expected14.activities).toEqual(e14.input.plan.activities.filter((a) => a.id !== "C"));
    expect(e14.expected.rules_only.status).toBe("needs_information");
    expect(e14.expected.rules_only.requiredIssues).toContain("unknown_travel_duration");
    // Retention is already impossible: a one-hour activity resumed at 17:10 ends at 18:10.
    expect(Date.parse(at("17:10")) + 60 * 60_000).toBeGreaterThan(Date.parse(at("18:00")));
  });

  it("reproduces the design's tool ordering for E13 and E14", async () => {
    const report = await runV2({ git, caseIds: ["E13", "E14"] });
    expect(edgesOf(rowOf(report.rows, "E13", "rules_only"))).toEqual([]);
    expect(edgesOf(rowOf(report.rows, "E13", "fixed_workflow")))
      .toEqual([["P-B", "P-C"], ["P-C", "P-D"], ["P-B", "P-D"]]);
    expect(edgesOf(rowOf(report.rows, "E13", "adaptive_workflow"))).toEqual([["P-B", "P-C"], ["P-C", "P-D"]]);
    expect(edgesOf(rowOf(report.rows, "E13", "model_agent"))).toEqual([["P-B", "P-C"], ["P-C", "P-D"]]);
    expect(edgesOf(rowOf(report.rows, "E14", "fixed_workflow")))
      .toEqual([["P-B", "P-C"], ["P-C", "P-D"], ["P-B", "P-D"]]);
    expect(edgesOf(rowOf(report.rows, "E14", "adaptive_workflow"))).toEqual([["P-B", "P-D"]]);
    expect(edgesOf(rowOf(report.rows, "E14", "model_agent"))).toEqual([["P-B", "P-D"]]);

    for (const row of report.rows) {
      expect(row.exception, `${row.caseId}/${row.plannerId}`).toBeNull();
      expect(row.score?.passed, `${row.caseId}/${row.plannerId}`).toBe(true);
    }
    const e13Adaptive = rowOf(report.rows, "E13", "adaptive_workflow");
    expect(e13Adaptive.output?.planningCalls).toBe(3);
    expect(e13Adaptive.score?.revalidation?.checkedTransitions.map((t) => t.earliestArrivalAt))
      .toEqual([at("15:50"), at("17:20")]);
    expect(rowOf(report.rows, "E14", "adaptive_workflow").score?.revalidation?.checkedTransitions.at(-1)
      ?.earliestArrivalAt).toBe(at("18:00"));
  });

  it("counts fewer queries on E13 without dropping the retention goal", async () => {
    const report = await runV2({ git, caseIds: ["E13"] });
    const adaptive = rowOf(report.rows, "E13", "adaptive_workflow");
    const fixed = rowOf(report.rows, "E13", "fixed_workflow");
    expect(adaptive.trace.length).toBeLessThan(fixed.trace.length);
    expect(adaptive.score?.quality).toBe(true);
    const output = adaptive.output;
    if (output?.result.status !== "candidate_found") throw new Error("expected a candidate");
    expect(output.result.selected.strategy).toBe("shift");
  });
});

describe("report invariants and data identity", () => {
  it("keeps v1 data intact and reports offline costs honestly", async () => {
    expect(datasetHash(dataset)).toBe("e5ca0c0c88916fb4d2ca9c57d61ca283d11451191f28f638774efddf96eafed3");
    const report = await runV2({ git });
    expect(report.schemaVersion).toBe(2);
    expect(report.limits).toEqual(LIMITS);
    expect(report.stoppedEarly).toBe(false);
    expect(report.skippedRuns).toBe(0);
    expect(report.profileId).toBeNull();
    expect(report.profileHash).toBeNull();
    expect(report.datasetVersion).toBe(datasetV2.version);
    expect(report.versions.graph).toMatch(/^bounded-route-graph/);
    for (const row of report.rows) {
      expect(row.cost.mapApiCalls).toBe(0);
      expect(row.cost.modelApiCalls).toBe(0);
      expect(row.cost.currency).toBeNull();
      expect(row.cost.estimatedAmount).toBe(0);
      expect(row.cost.inputTokens).toBe(0);
      expect(row.cost.outputTokens).toBe(0);
      expect(row.cost.note).toContain("离线");
      expect(row.modelMode).toBe(row.plannerId === "model_agent" ? "scripted" : "none");
      expect(row.output?.modelRequests).toBe(row.output?.decisions.length);
    }
    expect(report.summary.map((s) => s.modelApiCalls)).toEqual([0, 0, 0, 0]);
  });

  it("changes the dataset hash when a single authored number changes", () => {
    const baseline = datasetHash(dataset);
    const mutated = structuredClone(dataset);
    const world = mutated.cases[4].world[0];
    if (world.result.status !== "ok") throw new Error("E05 must carry a route");
    Reflect.set(world.result.routes[0], "durationSeconds", 2401);
    expect(datasetHash(mutated)).not.toBe(baseline);
    expect(datasetHash(structuredClone(dataset))).toBe(baseline);
  });

  it("makes every failed score axis carry at least one explicit reason", async () => {
    const report = await runV2({ git });
    for (const row of report.rows) {
      const score = row.score;
      expect(score, `${row.caseId}/${row.plannerId}`).not.toBeNull();
      if (!score) continue;
      const pairs = [
        ["quality", score.quality, score.qualityFailures],
        ["safety", score.safety, score.safetyFailures],
        ["execution", score.execution, score.executionFailures],
      ] as const;
      for (const [axis, ok, reasons] of pairs) {
        expect(reasons.length > 0, `${row.caseId}/${row.plannerId} ${axis}`).toBe(!ok);
      }
    }
  });
});

describe("adaptive_workflow obeys the same guards and budget as the graph", () => {
  const plan = generateBaselineCandidate;
  const e13 = () => caseOf("E13").input;

  it.each(["authorization_failed", "quota_exceeded"] as const)(
    "stops the loop on route %s and reports the matching error",
    async (code) => {
      const asked: string[] = [];
      const result = await runAdaptive(e13(), plan, async (from, to) => {
        asked.push(`${from}->${to}`);
        return {
          status: "failure" as const,
          failure: { code, retry: "never" as const, safeMessage: "synthetic" },
          evidence: { ...FIXTURE_EVIDENCE },
        };
      });
      expect(asked, "one attempt only, no automatic retry or extra direction").toEqual(["P-B->P-C"]);
      expect(result.error).toBe(code === "authorization_failed" ? "auth" : "quota");
      expect(result.executionStatus).toBe("model_error");
      expect(result.routeRequests).toBe(1);
      expect(result.planningCalls).toBe(2);
      expect(result.modelRequests).toBe(0);
      expect(result.observations).toEqual([
        { edge: ["P-B", "P-C"], status: "failure", failureCode: code },
      ]);
    },
  );

  it("never exceeds the shared route budget even when every direction fails", async () => {
    const asked: string[] = [];
    const result = await runAdaptive(e13(), plan, async (from, to) => {
      asked.push(`${from}->${to}`);
      return {
        status: "failure" as const,
        failure: { code: "timeout" as const, retry: "after_backoff" as const, safeMessage: "synthetic" },
        evidence: { ...FIXTURE_EVIDENCE },
      };
    });
    expect(asked.length, "at least one investigation").toBeGreaterThan(0);
    expect(new Set(asked).size, "no repeated direction").toBe(asked.length);
    expect(asked.length, "shared route budget").toBeLessThanOrEqual(LIMITS.routes);
    expect(result.routeRequests).toBe(asked.length);
    expect(result.error).toBeNull();
    expect(result.executionStatus).toBe("completed");
    expect(result.result.status).toBe("needs_information");
  });
});
