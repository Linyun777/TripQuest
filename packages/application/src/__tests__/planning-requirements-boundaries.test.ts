import { describe, expect, it } from "vitest";
import { validatePlanningRequirements } from "../planning-requirements";

/**
 * TQ-008.1 independent test (2026-10-08). Expectations are derived from the
 * S5.1 design §3, not from the implementation:
 * - fixed events lie inside [departure, latest arrival]; intervals are
 *   half-open, so touching events do not overlap, in any list order;
 * - required stays plus fixed time may equal the window but not exceed it;
 *   optional stays never count toward that necessary condition;
 * - required + fixed ≤ 6 within ≤ 8 visits; identity is provider + externalId.
 * Every rejection is paired with an accepted input that differs in one value,
 * so the rule under test is the only one that can reject it.
 */

type Visit = Record<string, unknown>;
type Window = { startsAt: string; endsAt: string };

function place(
  externalId: string,
  provider = "synthetic",
  name = `虚构地点 ${externalId}`,
) {
  return {
    place: {
      ref: { provider, externalId },
      name,
      cityAdcode: "330100",
      location: {
        longitude: 120.15,
        latitude: 30.25,
        coordinateSystem: "gcj02",
      },
    },
    evidence: {
      provider,
      sourceKind: "fixture",
      retrievedAt: "2026-10-08T02:00:00Z",
      attribution: "独立测试手写虚构",
    },
  };
}

function requirements(
  visits: Visit[],
  window: Window = { startsAt: "10:00", endsAt: "18:00" },
) {
  return {
    schemaVersion: "planning-requirements.v1",
    cityAdcode: "330100",
    timeZone: "Asia/Shanghai",
    travelMode: "walking",
    date: "2026-10-08",
    window,
    startPlace: place("START"),
    endPlace: place("START"),
    interests: ["city_walk"],
    pace: "standard",
    visits,
  };
}

const optional = (id: string, stayMinutes: unknown = 60): Visit => ({
  place: place(id),
  role: "optional",
  stayMinutes,
});
const required = (id: string, stayMinutes: unknown = 60): Visit => ({
  place: place(id),
  role: "required",
  stayMinutes,
});
const fixed = (id: string, startsAt: string, endsAt: string): Visit => ({
  place: place(id),
  role: "fixed",
  startsAt,
  endsAt,
});

function accepted(input: unknown): boolean {
  return validatePlanningRequirements(input).success;
}

describe("S5.1 planning requirements · independent boundaries", () => {
  it("lets required stays plus fixed time fill the window exactly, not one minute more; optional stays never count", () => {
    const window = { startsAt: "09:00", endsAt: "12:00" };
    const exact = [required("R", 120), fixed("F", "11:00", "12:00")];
    expect(accepted(requirements(exact, window)), "120 + 60 = 180").toBe(true);

    const over = [required("R", 121), fixed("F", "11:00", "12:00")];
    expect(accepted(requirements(over, window)), "121 + 60 = 181").toBe(false);

    const withOptional = [...exact, optional("O", 240)];
    expect(
      accepted(requirements(withOptional, window)),
      "an optional 240-minute stay is not a hard requirement",
    ).toBe(true);
  });

  it("keeps fixed events inside the window with half-open edges, whatever the list order", () => {
    const touchingEdges = [
      fixed("F", "10:00", "11:00"),
      fixed("G", "17:00", "18:00"),
    ];
    expect(accepted(requirements(touchingEdges)), "both window edges").toBe(
      true,
    );
    expect(
      accepted(requirements([fixed("F", "09:59", "11:00")])),
      "starts one minute before departure",
    ).toBe(false);
    expect(
      accepted(requirements([fixed("G", "17:00", "18:01")])),
      "ends one minute after the latest arrival",
    ).toBe(false);
    expect(
      accepted(requirements([fixed("F", "12:00", "12:00")])),
      "zero-length fixed event",
    ).toBe(false);
    expect(
      accepted(requirements([fixed("F", "13:00", "12:00")])),
      "reversed fixed event",
    ).toBe(false);

    const adjacentLaterFirst = [
      fixed("F", "15:00", "16:00"),
      fixed("G", "14:00", "15:00"),
    ];
    expect(
      accepted(requirements(adjacentLaterFirst)),
      "adjacent events listed later-first",
    ).toBe(true);
    const overlappingLaterFirst = [
      fixed("F", "15:00", "16:00"),
      fixed("G", "14:30", "15:30"),
    ];
    expect(
      accepted(requirements(overlappingLaterFirst)),
      "overlapping events listed later-first",
    ).toBe(false);
  });

  it("counts fixed events toward the six hard visits inside the eight-visit limit", () => {
    const sixHard = [
      fixed("F1", "10:00", "10:30"),
      fixed("F2", "11:00", "11:30"),
      required("R1", 15),
      required("R2", 15),
      required("R3", 15),
      required("R4", 15),
      optional("O1", 15),
      optional("O2", 15),
    ];
    expect(accepted(requirements(sixHard)), "2 fixed + 4 required").toBe(true);

    const sevenHard = sixHard.map((visit, index) =>
      index === 7 ? required("O2", 15) : visit,
    );
    expect(accepted(requirements(sevenHard)), "2 fixed + 5 required").toBe(
      false,
    );
  });

  it("identifies a visit by provider plus external ID, whatever its role or display name", () => {
    const distinct = [optional("X"), fixed("Y", "12:00", "13:00")];
    expect(accepted(requirements(distinct)), "two different places").toBe(
      true,
    );

    const renamedTwin = {
      ...fixed("Y", "12:00", "13:00"),
      place: place("X", "synthetic", "另一个显示名称"),
    };
    expect(
      accepted(requirements([optional("X"), renamedTwin])),
      "same place as optional and as a renamed fixed event",
    ).toBe(false);

    const otherProvider = {
      ...optional("X"),
      place: place("X", "another-provider"),
    };
    expect(
      accepted(requirements([optional("X"), otherProvider])),
      "same external ID from another provider",
    ).toBe(true);
    expect(
      accepted(requirements([optional("START")])),
      "start, end and one visit may share a place",
    ).toBe(true);
  });

  it("rejects out-of-range stays, loose clock strings and fields that belong to the other role", () => {
    expect(accepted(requirements([])), "baseline without visits").toBe(true);

    const stays: [unknown, boolean][] = [
      [14, false],
      [15, true],
      // V2.10：大景区、爬山可以占大半天（上限 600；这里的时间窗只有 9 小时）。
      [480, true],
      [601, false],
      [60.5, false],
      [Number.NaN, false],
    ];
    for (const [stay, ok] of stays) {
      expect(
        accepted(requirements([required("R", stay)])),
        `stay ${String(stay)}`,
      ).toBe(ok);
    }

    const windows: Window[] = [
      { startsAt: "09:00", endsAt: "24:00" },
      { startsAt: "9:00", endsAt: "12:00" },
      { startsAt: "09:00:00", endsAt: "12:00" },
      { startsAt: "10:00", endsAt: "10:00" },
    ];
    for (const window of windows) {
      expect(
        accepted(requirements([], window)),
        JSON.stringify(window),
      ).toBe(false);
    }

    const fixedWithStay = { ...fixed("F", "12:00", "13:00"), stayMinutes: 60 };
    expect(
      accepted(requirements([fixedWithStay])),
      "fixed event carrying a stay",
    ).toBe(false);
    const optionalWithTime = { ...optional("O"), startsAt: "12:00" };
    expect(
      accepted(requirements([optionalWithTime])),
      "optional visit carrying a fixed time",
    ).toBe(false);
    expect(
      accepted({ ...requirements([]), travelMode: "driving" }),
      "travel mode is fixed to walking",
    ).toBe(false);
    expect(
      accepted({ ...requirements([]), cityAdcode: "3302" }),
      "a city is a 6-digit code (V2.10: any city, not only Hangzhou)",
    ).toBe(false);
    expect(accepted({ ...requirements([]), cityAdcode: "510100" }), "V2.10: other cities are accepted").toBe(true);
  });
});
