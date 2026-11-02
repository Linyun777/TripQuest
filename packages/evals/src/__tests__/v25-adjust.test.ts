import { describe, expect, it } from "vitest";
import { ADJUST_INTAKE_CASES, ADJUST_PLAN_CASES, adjustChecks, scoreAdjust, type AdjustOutcome } from "../v21/adjust-dataset";
import { runAdjustAsDay, runAdjustFlow } from "../v21/adjust-run";

const plan = (id: string) => ADJUST_PLAN_CASES.find((item) => item.id === id)!;
const at = (placeId: string, startsAt: string, endsAt = "23:00") => ({ placeId, startsAt, endsAt });
const outcome = (stops: AdjustOutcome["stops"], extra: Partial<AdjustOutcome> = {}): AdjustOutcome =>
  ({ planned: true, stops, violations: [], ...extra });

describe("V2.5 adjustment scoring", () => {
  it("catches the wrong adjusted days it exists for, and passes the right one", () => {
    // R02: opera replaced by coffee, tea kept, the museum is history.
    expect(scoreAdjust(plan("R02"), outcome([at("V23-CAFE", "11:30"), at("V21-TEA", "14:00")]))).toEqual({
      completedAgain: 0, keptMissing: 0, removedPresent: 0, addedCovered: 1, addedWanted: 1,
      beforeResume: 0, fixedMoved: 0, outcomeMatched: true, orderKept: null,
    });
    // Re-planning the whole day: the museum again, before now, the opera still there, tea dropped.
    expect(scoreAdjust(plan("R02"), outcome([at("V21-MUSEUM", "09:30"), at("V21-OPERA", "11:30")]))).toMatchObject({
      completedAgain: 1, keptMissing: 1, removedPresent: 1, addedCovered: 0, beforeResume: 1,
    });
    // R04: the appointment must not move, and "does not fit" must come with the right suggestion.
    expect(scoreAdjust(plan("R04"), outcome([at("V21-TEA", "14:30", "15:30")])).fixedMoved).toBe(1);
    expect(scoreAdjust(plan("R04"), outcome([], { planned: false, suggestDrop: "V21-OPERA" })).outcomeMatched).toBe(true);
    expect(scoreAdjust(plan("R04"), outcome([], { planned: false, suggestDrop: "V21-TEA" })).outcomeMatched).toBe(false);
    expect(scoreAdjust(plan("R04"), outcome([at("V21-OPERA", "13:40"), at("V21-TEA", "14:00", "15:00")])).outcomeMatched).toBe(false);
    // R09 (short trip): the tea replaces the last stop, so it comes after the snack street.
    expect(scoreAdjust(plan("R09"), outcome([at("V21-TEA", "11:20"), at("V21-SNACK", "12:30")])).orderKept).toBe(false);
    expect(scoreAdjust(plan("R09"), outcome([at("V21-SNACK", "11:20"), at("V21-TEA", "12:30")])).orderKept).toBe(true);
  });

  it("reads the produced request against the truth, part by part", () => {
    const A03 = ADJUST_INTAKE_CASES.find((item) => item.id === "A03")!;
    const right = { completed: [], skipped: [], replace: [{ stop: "s2", interest: "喝咖啡" }], addInterests: [] };
    expect(adjustChecks(A03.truth, right).every((check) => check.passed)).toBe(true);
    // Skipping instead of replacing misses both parts; nothing produced misses the whole case.
    const skipped = adjustChecks(A03.truth, { skipped: ["s2"] }).filter((check) => !check.passed).map((check) => check.name);
    expect(skipped).toEqual(["skipped", "replace"]);
    expect(adjustChecks(A03.truth, undefined)).toEqual([{ name: "adjustment_made", passed: false }]);
    // Another day is not this trip: any adjustment is wrong.
    const A07 = ADJUST_INTAKE_CASES.find((item) => item.id === "A07")!;
    expect(adjustChecks(A07.truth, undefined)[0].passed).toBe(true);
    expect(adjustChecks(A07.truth, right)[0].passed).toBe(false);
    // V2.6: "从我这儿重新排" must say where from; elsewhere the default (last stop done) is right.
    const A15 = ADJUST_INTAKE_CASES.find((item) => item.id === "A15")!;
    expect(adjustChecks(A15.truth, { from: "here" }).every((check) => check.passed)).toBe(true);
    expect(adjustChecks(A15.truth, { from: "last_done" }).find((check) => check.name === "from")!.passed).toBe(false);
    expect(adjustChecks(A03.truth, { ...right, from: "last_done" }).every((check) => check.passed)).toBe(true);
  });

  it("runs the baseline (re-plan the day from the card) with the rules policy without violations", async () => {
    const rows = await Promise.all(ADJUST_PLAN_CASES.map((item) => runAdjustAsDay(item, "scripted")));
    expect(rows.flatMap((row) => row.outcome.violations)).toEqual([]);
    expect(rows.every((row) => row.flow === "day")).toBe(true);
  });

  it("runs the adjustment flow with the rules policy: history untouched, kept stops kept, honest suggestions", async () => {
    const rows = await Promise.all(ADJUST_PLAN_CASES.map((item) => runAdjustFlow(item, "scripted")));
    expect(rows.flatMap((row) => row.outcome.violations)).toEqual([]);
    expect(rows.every((row) => row.score.completedAgain === 0 && row.score.keptMissing === 0 && row.score.beforeResume === 0 && row.score.fixedMoved === 0)).toBe(true);
    // Too late for the appointment with the opera kept: the opera is proposed for dropping, not dropped.
    expect(rows.find((row) => row.caseId === "R04")!.outcome).toMatchObject({ planned: false, suggestDrop: "V21-OPERA" });
    expect(rows.find((row) => row.caseId === "R05")!.outcome).toMatchObject({ planned: false, suggestDrop: "V21-TEA" });
    // A short trip keeps its order: the replacement comes where the replaced stop was.
    expect(rows.find((row) => row.caseId === "R09")!.score.orderKept).toBe(true);
  });
});
