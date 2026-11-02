import { describe, expect, it } from "vitest";
import { SHORT_PLAN_CASES, scoreShort, type ShortOutcome } from "../v21/short-dataset";
import { runShortAsDay, runShortFlow } from "../v21/short-run";
import { worldPlace } from "../v21/world";

const S01 = SHORT_PLAN_CASES.find((item) => item.id === "S01")!;
const outcome = (stops: string[], extra: Partial<ShortOutcome> = {}): ShortOutcome =>
  ({ planned: true, stops, endsAtStart: false, violations: [], ...extra });

describe("V2.4 short-trip scoring", () => {
  it("catches the wrong results it exists for, and passes the right one", () => {
    // Coffee right next to the restaurant, no way back: all good.
    expect(scoreShort(S01, outcome(["V24-SPICY-A", "V24-LUCKIN-B"]))).toMatchObject({
      covered: 2, chainExcessMeters: 0, wrongEnd: false,
    });
    // Coffee by the start instead (as when searched around the start): about 1.5 km too far.
    expect(scoreShort(S01, outcome(["V24-SPICY-A", "V24-LUCKIN-A"])).chainExcessMeters).toBeGreaterThan(1400);
    // Coffee dropped, and the day returns home although nobody asked.
    expect(scoreShort(S01, outcome(["V24-SPICY-A"], { endsAtStart: true }))).toMatchObject({ covered: 1, wrongEnd: true });
    // Steps offering too few, repeated or wrong candidates are not good steps.
    const steps = [
      { interest: "i1", offered: ["V24-SPICY-A", "V24-SPICY-B", "V24-SPICY-C"] },
      { interest: "i2", offered: ["V24-LUCKIN-B", "V24-LUCKIN-B", "V24-LUCKIN-A"] },
    ];
    expect(scoreShort(S01, outcome(["V24-SPICY-A", "V24-LUCKIN-B"], { steps })).goodSteps).toBe(1);
    expect(scoreShort(S01, outcome(["V24-SPICY-A", "V24-LUCKIN-B"], {
      steps: [{ interest: "i1", offered: ["V24-SPICY-A", "V23-HOTPOT", "V24-SPICY-B"] }],
    })).goodSteps).toBe(0);
    // Two offered while three fit nearby is short; one hotpot when only one exists is right.
    expect(scoreShort(S01, outcome(["V24-SPICY-A"], { steps: [{ interest: "i1", offered: ["V24-SPICY-A", "V24-SPICY-B"] }] })).goodSteps).toBe(0);
    const hotpot = SHORT_PLAN_CASES.find((item) => item.id === "S03")!;
    expect(scoreShort(hotpot, outcome(["V23-HOTPOT"], { steps: [{ interest: "i1", offered: ["V23-HOTPOT"] }] })).goodSteps).toBe(1);
  });

  it("has cases a correct flow can satisfy: each next stop has a fit within search reach", () => {
    const reach = (from: string, ids: readonly string[]) => ids.filter((id) => {
      const [a, b] = [worldPlace(from), worldPlace(id)];
      return Math.hypot(a.x - b.x, a.y - b.y) <= 30;
    });
    for (const item of SHORT_PLAN_CASES) {
      let anchors = [item.start];
      for (const interest of item.interests) {
        const fits = item.satisfiedBy[interest.id];
        // From every place the previous step could pick, this step still has a fit nearby.
        for (const anchor of anchors) expect(reach(anchor, fits).length, `${item.id} ${interest.id} from ${anchor}`).toBeGreaterThan(0);
        anchors = reach(anchors[0], fits);
      }
    }
  });

  it("runs the baseline (today's day planner) with the rules policy without violations", async () => {
    const rows = await Promise.all(SHORT_PLAN_CASES.map((item) => runShortAsDay(item, "scripted")));
    expect(rows.flatMap((row) => row.outcome.violations)).toEqual([]);
    expect(rows.every((row) => row.flow === "day" && row.score.goodSteps === null)).toBe(true);
  });

  it("runs the short flow with the rules policy: candidates each step, no violations, the right end", async () => {
    const rows = await Promise.all(SHORT_PLAN_CASES.map((item) => runShortFlow(item, "scripted")));
    expect(rows.flatMap((row) => row.outcome.violations)).toEqual([]);
    expect(rows.find((row) => row.caseId === "S05")!.outcome.endsAtStart).toBe(true);
    expect(rows.filter((row) => row.outcome.planned).every((row) => row.score.wrongEnd === false)).toBe(true);
  });

  it("V2.5: counts a shop offered or planned while the world says it is closed", () => {
    const S07 = SHORT_PLAN_CASES.find((item) => item.id === "S07")!;
    // The nearest shop closed at 14:30: offering it, or planning it at 14:50, is wrong.
    const wrong = outcome(["V25-FLOWER-A"], {
      steps: [{ interest: "i1", offered: ["V25-FLOWER-A", "V25-FLOWER-B", "V25-FLOWER-C"] }],
      times: [{ startsAt: 14 * 60 + 50, endsAt: 15 * 60 + 20 }],
    });
    expect(scoreShort(S07, wrong)).toMatchObject({ closedOffers: 1, closedStops: 1, goodSteps: 0 });
    // Open shops only (one with unknown hours is fine), planned while open.
    const right = outcome(["V25-FLOWER-B"], {
      steps: [{ interest: "i1", offered: ["V25-FLOWER-B", "V25-FLOWER-C", "V25-FLOWER-D"] }],
      times: [{ startsAt: 14 * 60 + 50, endsAt: 15 * 60 + 20 }],
    });
    expect(scoreShort(S07, right)).toMatchObject({ closedOffers: 0, closedStops: 0, goodSteps: 1, covered: 1 });
    // S08's second step sets off after the meal (16:19): the shop closing at 16:00 is no longer a fit.
    const S08 = SHORT_PLAN_CASES.find((item) => item.id === "S08")!;
    const later = outcome(["V24-SPICY-A", "V25-FLOWER-C"], {
      steps: [{ interest: "i1", offered: ["V24-SPICY-A"] }, { interest: "i2", offered: ["V25-FLOWER-C", "V25-FLOWER-B"] }],
      times: [{ startsAt: 904, endsAt: 979 }, { startsAt: 990, endsAt: 1010 }],
    });
    expect(scoreShort(S08, later)).toMatchObject({ closedOffers: 0, closedStops: 0 });
    expect(scoreShort(S08, { ...later, steps: [later.steps![0], { interest: "i2", offered: ["V25-FLOWER-D", "V25-FLOWER-C"] }] }).closedOffers).toBe(1);
    // S09 sets off at 19:30: the shop closing at 20:00 is no longer an offer.
    const S09 = SHORT_PLAN_CASES.find((item) => item.id === "S09")!;
    expect(scoreShort(S09, outcome(["V25-FLOWER-C"], { steps: [{ interest: "i1", offered: ["V25-FLOWER-B", "V25-FLOWER-C"] }] })).closedOffers).toBe(1);
    expect(scoreShort(S09, outcome(["V25-FLOWER-C"], { steps: [{ interest: "i1", offered: ["V25-FLOWER-C"] }] })).closedOffers).toBe(0);
    // Closing at 16:00, a 15:50–16:20 visit is already a closed stop.
    expect(scoreShort(S07, outcome(["V25-FLOWER-D"], { times: [{ startsAt: 15 * 60 + 50, endsAt: 16 * 60 + 20 }] })).closedStops).toBe(1);
  });
});
