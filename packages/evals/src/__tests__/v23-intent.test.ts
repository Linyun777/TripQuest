import { describe, expect, it } from "vitest";
import { INTENT_PLAN_CASES, SLOT_WINDOWS, scoreIntent, type ScoredStop } from "../v21/intent-dataset";
import { runPlanCase } from "../v21/run";
import { worldPlace } from "../v21/world";

const P18 = INTENT_PLAN_CASES.find((item) => item.id === "P18")!;
const at = (externalId: string, startsAt: string, minutes = 90, waitMinutes = 0): ScoredStop => {
  const start = Number(startsAt.slice(0, 2)) * 60 + Number(startsAt.slice(3));
  return { externalId, startsAt: start, endsAt: start + minutes, waitMinutes };
};
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

describe("V2.3 intent scoring", () => {
  it("catches the wrong plans it exists for, and passes the right one", () => {
    expect(scoreIntent(P18, [at("V23-BAR-A", "18:30")])).toEqual({
      overCount: 0, underCount: 0, slotChecked: 1, slotMisses: 0, firstWaitMinutes: 0,
    });
    // Three bars: two too many.
    expect(scoreIntent(P18, [at("V23-BAR-A", "17:10"), at("V23-BAR-B", "18:50"), at("V23-BAR-C", "20:20")]))
      .toMatchObject({ overCount: 2, slotMisses: 1 });
    // A drink at three in the afternoon, after waiting all day for it.
    expect(scoreIntent(P18, [at("V23-BAR-B", "15:00", 90, 480)])).toMatchObject({ slotMisses: 1, firstWaitMinutes: 480 });
    // "多逛几家书店" with one bookstore is one short.
    const books = INTENT_PLAN_CASES.find((item) => item.id === "P20")!;
    expect(scoreIntent(books, [at("V21-BOOKS", "13:30")])).toMatchObject({ underCount: 1, overCount: 0 });
  });

  it("has cases a correct plan can satisfy: known places, slots inside the window, within search reach", () => {
    for (const item of INTENT_PLAN_CASES) {
      const window = item.requirements.window;
      const start = worldPlace(item.requirements.startPlace.place.ref.externalId);
      for (const [id, intent] of Object.entries(item.intents!)) {
        // Searches anchor at the start (3 km; the grid unit is ~100 m): at least one fit must be in reach.
        const reachable = item.satisfiedBy[id].filter((placeId) => {
          const place = worldPlace(placeId);
          return Math.hypot(place.x - start.x, place.y - start.y) <= 30;
        });
        expect(reachable.length, `${item.id} ${id}`).toBeGreaterThanOrEqual(intent.min);
        if (intent.when === "any") continue;
        const slot = SLOT_WINDOWS[intent.when];
        const overlap = Math.min(slot.endsAt, minutes(window.endsAt)) - Math.max(slot.startsAt, minutes(window.startsAt));
        expect(overlap, `${item.id} ${id} slot inside window`).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it("runs every case with the rules policy without violations", async () => {
    const rows = await Promise.all(INTENT_PLAN_CASES.map((item) => runPlanCase(item, "scripted")));
    expect(rows.flatMap((row) => row.violations)).toEqual([]);
    expect(rows.every((row) => row.outcome !== "draft" || row.intent)).toBe(true);
  });
});
