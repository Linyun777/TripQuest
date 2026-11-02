import { describe, expect, it } from "vitest";
import {
  validatePlanningRequirements,
  type PlanningRequirements,
} from "../planning-requirements";

function requirements(): PlanningRequirements {
  const place = {
    place: {
      ref: { provider: "synthetic", externalId: "A" },
      name: "同名演示地点",
      cityAdcode: "330100",
      location: {
        longitude: 120,
        latitude: 30,
        coordinateSystem: "gcj02" as const,
      },
    },
    evidence: {
      provider: "synthetic",
      sourceKind: "fixture" as const,
      retrievedAt: "2026-10-08T00:00:00Z",
      attribution: "手写虚构",
    },
  };
  return {
    schemaVersion: "planning-requirements.v1",
    cityAdcode: "330100",
    timeZone: "Asia/Shanghai",
    travelMode: "walking",
    date: "2026-10-08",
    window: { startsAt: "10:00", endsAt: "18:00" },
    startPlace: place,
    endPlace: structuredClone(place),
    interests: ["culture"],
    pace: "relaxed",
    visits: [],
  };
}
function failures(value: unknown): string[] {
  const result = validatePlanningRequirements(value);
  expect(result.success).toBe(false);
  return result.success ? [] : Object.keys(result.fieldErrors);
}
function withVisits(count: number): PlanningRequirements {
  const value = requirements();
  value.visits = Array.from({ length: count }, (_, index) => ({
    role: "required",
    stayMinutes: 15,
    place: {
      ...structuredClone(value.startPlace),
      place: {
        ...value.startPlace.place,
        ref: { provider: "synthetic", externalId: String(index) },
      },
    },
  }));
  return value;
}

describe("planning requirements independent of a scheduled journey", () => {
  it("accepts interests with no visits, same start/end, and a historical leap day", () => {
    const value = requirements();
    value.date = "2024-02-29";
    expect(validatePlanningRequirements(value)).toMatchObject({
      success: true,
    });
    value.interests = [];
    expect(failures(value)).toContain("interests");
    value.visits = [
      { place: value.startPlace, role: "optional", stayMinutes: 60 },
    ];
    expect(validatePlanningRequirements(value).success).toBe(true);
  });
  it.each(["2026-02-29", "2100-02-29", "2026-04-31", "26-10-08"])(
    "refuses bad date %s",
    (date) => {
      expect(failures({ ...requirements(), date })).toContain("date");
    },
  );
  it("rejects cross-midnight/reversed windows and unknown fields at every boundary", () => {
    expect(
      failures({
        ...requirements(),
        window: { startsAt: "23:00", endsAt: "01:00" },
      }),
    ).toContain("window.endsAt");
    expect(failures({ ...requirements(), admin: true })).toContain("form");
    expect(
      failures({ ...requirements(), interests: ["culture", "culture"] }),
    ).toContain("interests");
    const value = requirements();
    expect(
      failures({
        ...value,
        startPlace: { ...value.startPlace, verified: true },
      }),
    ).toContain("startPlace");
  });
  it("keeps same-name different IDs distinct and rejects duplicated identity", () => {
    const value = withVisits(2);
    expect(validatePlanningRequirements(value).success).toBe(true);
    value.visits[1] = {
      ...value.visits[1],
      place: {
        ...value.visits[1].place,
        place: {
          ...value.visits[1].place.place,
          ref: { ...value.visits[0].place.place.ref },
        },
      },
    };
    expect(failures(value)).toContain("visits.1.place");
  });
  it("enforces all three limits without counting endpoints as activities", () => {
    expect(validatePlanningRequirements(withVisits(6)).success).toBe(true);
    expect(failures(withVisits(7))).toContain("visits");
    const optional = withVisits(8);
    optional.visits = optional.visits.map((visit) => ({
      place: visit.place,
      role: "optional",
      stayMinutes: 15,
    }));
    expect(validatePlanningRequirements(optional).success).toBe(true);
    optional.visits.push(optional.visits[0]);
    expect(failures(optional)).toContain("visits");
    const fixed = withVisits(3);
    fixed.visits = fixed.visits.map((visit, i) => ({
      place: visit.place,
      role: "fixed",
      startsAt: `${10 + i}:00`,
      endsAt: `${10 + i}:30`,
    }));
    expect(failures(fixed)).toContain("visits");
  });
  it("accepts adjacent fixed intervals; rejects overlap and window overflow", () => {
    const value = withVisits(2);
    value.visits = [
      {
        place: value.visits[0].place,
        role: "fixed",
        startsAt: "10:00",
        endsAt: "11:00",
      },
      {
        place: value.visits[1].place,
        role: "fixed",
        startsAt: "11:00",
        endsAt: "12:00",
      },
    ];
    expect(validatePlanningRequirements(value).success).toBe(true);
    value.visits[1] = {
      ...value.visits[1],
      role: "fixed",
      startsAt: "10:59",
      endsAt: "12:00",
    };
    expect(failures(value)).toContain("visits.1.startsAt");
    value.visits[1] = {
      ...value.visits[1],
      role: "fixed",
      startsAt: "17:30",
      endsAt: "18:01",
    };
    expect(failures(value)).toContain("visits.1.startsAt");
  });
  it("rejects necessary duration overflow but does not require optional durations to fit", () => {
    const value = withVisits(2);
    value.window = { startsAt: "10:00", endsAt: "11:00" };
    value.visits = value.visits.map((visit) => ({
      ...visit,
      role: "required",
      stayMinutes: 31,
    }));
    expect(failures(value)).toContain("visits");
    value.visits = value.visits.map((visit) => ({
      place: visit.place,
      role: "optional",
      stayMinutes: 31,
    }));
    expect(validatePlanningRequirements(value).success).toBe(true);
    expect(
      failures({
        ...value,
        visits: [{ ...value.visits[0], stayMinutes: "60" }],
      }),
    ).toContain("visits.0.stayMinutes");
  });
});
