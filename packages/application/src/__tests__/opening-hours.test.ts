import { describe, expect, it } from "vitest";
import { createDayPlanningProblem } from "../day-planning";
import { openingFor, parseOpenToday } from "../opening-hours";
import { planningPlaceSchema, planningRequirementsSchema } from "../planning-requirements";

// V2.5: synthetic places; the hours strings follow Amap's opentime_today.
const place = (externalId: string, openToday?: string) => ({
  place: {
    ref: { provider: "amap", externalId },
    name: `合成${externalId}`,
    cityAdcode: "330100",
    location: { longitude: 120.1, latitude: 30.2, coordinateSystem: "gcj02" },
    ...(openToday ? { business: { openToday, rating: 4.5, costYuan: 30 } } : {}),
  },
  // 18:20 on 10-15 in Hangzhou.
  evidence: { provider: "amap", sourceKind: "live", retrievedAt: "2026-10-15T10:20:00.000Z", attribution: "高德地图" },
});

describe("V2.5 today's opening hours", () => {
  it("reads Amap's hours, overnight and split ones included, and leaves anything odd unknown", () => {
    expect(parseOpenToday("10:00-17:00")).toEqual([{ startsAt: 600, endsAt: 1020 }]);
    expect(parseOpenToday("17:00-21:00 11:00-14:00")).toEqual([{ startsAt: 660, endsAt: 840 }, { startsAt: 1020, endsAt: 1260 }]);
    // Past midnight and all day both run to the end of today.
    expect(parseOpenToday("17:00-02:00")).toEqual([{ startsAt: 1020, endsAt: 1439 }]);
    expect(parseOpenToday("00:00-24:00")).toEqual([{ startsAt: 0, endsAt: 1439 }]);
    expect(parseOpenToday("周一至周五")).toBeNull();
    expect(parseOpenToday("10:00-")).toBeNull();
  });

  it("turns them into the place's hours for the day they were read, and drops the other facts", () => {
    const parsed = planningPlaceSchema.parse(place("SYN1", "10:00-17:00"));
    expect(parsed.hours).toEqual({ date: "2026-10-15", windows: [{ startsAt: 600, endsAt: 1020 }] });
    expect(JSON.stringify(parsed)).not.toMatch(/business|rating|cost/);
    expect(planningPlaceSchema.parse(place("SYN2")).hours).toBeUndefined();
    // Only that day's plan can use them.
    expect(openingFor(parsed.hours, "2026-10-15")).toMatchObject({ status: "known", windows: [{ startsAt: 600 }] });
    expect(openingFor(parsed.hours, "2026-10-16")).toEqual({ status: "unknown" });
  });

  it("gives a must-go stop its hours in today's plan, so it is never scheduled closed", () => {
    const requirements = planningRequirementsSchema.parse({
      schemaVersion: "planning-requirements.v1", cityAdcode: "330100", timeZone: "Asia/Shanghai", travelMode: "walking",
      date: "2026-10-15", window: { startsAt: "18:30", endsAt: "22:00" },
      startPlace: place("SYN0"), endPlace: place("SYN0"), interests: [], pace: "standard",
      visits: [{ place: place("SYN1", "10:00-17:00"), role: "required", stayMinutes: 60 }],
    });
    const problem = createDayPlanningProblem({ requirements, runId: "r1", requirementsFingerprint: "a".repeat(64), nowMs: Date.parse("2026-10-15T10:20:00Z") });
    expect(problem.activities[0].activity.opening).toEqual({ status: "known", date: "2026-10-15", windows: [{ startsAt: 600, endsAt: 1020 }] });
  });
});
