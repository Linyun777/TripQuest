import { describe, expect, it } from "vitest";
import type { MobilityProvider, PlaceSummary, RouteOption, RouteRequest } from "@tripquest/providers";
import { chooseLeg, modesToTry, pickOption } from "../leg-choice";
import { DEFAULT_TRAVEL, WALKING_ONLY, type TravelPreference } from "../planning-requirements";

// Synthetic places and routes only.
const place = (id: string, longitude: number, latitude: number): PlaceSummary => ({
  ref: { provider: "amap", externalId: id },
  name: id,
  cityAdcode: "330100",
  location: { longitude, latitude, coordinateSystem: "gcj02" },
});
const near = { placeId: "p1", place: place("A", 120.15, 30.27) };
const close = { placeId: "p2", place: place("B", 120.155, 30.27) }; // ≈ 480 m
const mid = { placeId: "p3", place: place("C", 120.175, 30.27) }; // ≈ 2.4 km
const far = { placeId: "p4", place: place("D", 120.25, 30.27) }; // ≈ 9.6 km

function provider(answers: Partial<Record<RouteRequest["mode"], RouteOption | "none">>) {
  const asked: string[] = [];
  const routes: Pick<MobilityProvider, "findRoutes"> = {
    async findRoutes(request) {
      asked.push(request.mode);
      const answer = answers[request.mode];
      const evidence = { provider: "amap", sourceKind: "live" as const, attribution: "高德地图", retrievedAt: "2026-10-14T01:00:00Z" };
      if (!answer || answer === "none") return { status: "no_route", reason: "no_path", evidence };
      return { status: "ok", routes: [answer], evidence };
    },
  };
  return { routes, asked };
}
const walk = (minutes: number): RouteOption => ({ mode: "walking", durationSeconds: minutes * 60, distanceMeters: minutes * 80 });
const transit = (minutes: number, walkMeters = 600, fare = 3): RouteOption =>
  ({ mode: "transit", durationSeconds: minutes * 60, distanceMeters: 9000, fareYuan: fare, summary: "地铁2号线", walkingMeters: walkMeters });
const taxi = (minutes: number, fare = 30): RouteOption => ({ mode: "taxi", durationSeconds: minutes * 60, distanceMeters: 9000, fareYuan: fare });

const choose = (from: typeof near, to: typeof near, travel: TravelPreference, answers: Parameters<typeof provider>[0], mode?: RouteRequest["mode"]) => {
  const { routes, asked } = provider(answers);
  return chooseLeg({ from, to, travel, provider: routes, departureAt: "2026-10-15T09:00:00+08:00", mode }).then((chosen) => ({ chosen, asked }));
};

describe("V2.2 leg choice", () => {
  it("asks only the modes worth asking for the distance", () => {
    expect(modesToTry(500, DEFAULT_TRAVEL)).toEqual(["walking"]);
    expect(modesToTry(2500, DEFAULT_TRAVEL)).toEqual(["walking", "transit"]);
    expect(modesToTry(9000, DEFAULT_TRAVEL)).toEqual(["transit", "taxi"]);
    expect(modesToTry(9000, { allowed: ["walking", "transit", "taxi", "bicycling", "driving"], prefer: "fast" }))
      .toEqual(["transit", "taxi", "driving", "bicycling"]);
    // Walking only (V1/V2.1 data): a far leg is still asked as a walk.
    expect(modesToTry(9000, WALKING_ONLY)).toEqual(["walking"]);
  });

  it("walks short legs, and stores walking without a mode field (old shape)", async () => {
    const { chosen, asked } = await choose(near, close, DEFAULT_TRAVEL, { walking: walk(7) });
    expect(asked).toEqual(["walking"]);
    expect(chosen.route).toMatchObject({ status: "known", durationSeconds: 420 });
    expect(chosen.route).not.toHaveProperty("mode");
  });

  it("weighs time, walking and money by preference", async () => {
    const far9 = { transit: transit(40, 1500, 4), taxi: taxi(22, 35) };
    expect((await choose(near, far, { ...DEFAULT_TRAVEL, prefer: "balanced" }, far9)).chosen.route).toMatchObject({ mode: "transit", fareYuan: 4, summary: "地铁2号线" });
    expect((await choose(near, far, { ...DEFAULT_TRAVEL, prefer: "fast" }, far9)).chosen.route).toMatchObject({ mode: "taxi", fareYuan: 35 });
    expect((await choose(near, far, { ...DEFAULT_TRAVEL, prefer: "cheap" }, far9)).chosen.route).toMatchObject({ mode: "transit" });
    // A medium leg: walking 30 min is beaten by transit when walking less matters.
    const mid30 = { walking: walk(30), transit: transit(14, 300, 2) };
    expect((await choose(near, mid, { ...DEFAULT_TRAVEL, prefer: "less_walking" }, mid30)).chosen.route).toMatchObject({ mode: "transit" });
  });

  it("never uses an excluded mode, and reports an unknown leg when nothing answers", async () => {
    const noTaxi = { allowed: ["walking", "transit"] as TravelPreference["allowed"], prefer: "fast" as const };
    const { asked } = await choose(near, far, noTaxi, { transit: transit(40), taxi: taxi(10) });
    expect(asked).toEqual(["transit"]);
    expect((await choose(near, far, DEFAULT_TRAVEL, { transit: "none", taxi: "none" })).chosen.route)
      .toMatchObject({ status: "unknown", reason: "no_path" });
  });

  it("also asks for a taxi when a short leg is slow both ways (a lake in the way)", async () => {
    const aroundTheLake = { walking: walk(80), transit: transit(70, 1700, 2), taxi: taxi(15, 20) };
    const slow = await choose(near, mid, DEFAULT_TRAVEL, aroundTheLake);
    expect(slow.asked).toEqual(["walking", "transit", "taxi"]);
    expect(slow.chosen.route).toMatchObject({ mode: "taxi" });
    // A quick answer, or no ride allowed: no extra request.
    expect((await choose(near, mid, DEFAULT_TRAVEL, { ...aroundTheLake, walking: walk(28) })).asked).toEqual(["walking", "transit"]);
    expect((await choose(near, mid, { allowed: ["walking", "transit"], prefer: "balanced" }, aroundTheLake)).asked)
      .toEqual(["walking", "transit"]);
  });

  it("rechecks a saved leg with its saved mode only, never a substitute", async () => {
    const { chosen, asked } = await choose(near, far, DEFAULT_TRAVEL, { taxi: taxi(10), transit: "none" }, "transit");
    expect(asked).toEqual(["transit"]);
    expect(chosen.route.status).toBe("unknown");
  });

  it("adds the fixed parking allowance to a driving leg", async () => {
    const drive: RouteOption = { mode: "driving", durationSeconds: 20 * 60, distanceMeters: 9000 };
    const { chosen } = await choose(near, far, { allowed: ["walking", "driving"], prefer: "fast" }, { driving: drive });
    expect(chosen.route).toMatchObject({ mode: "driving", durationSeconds: 30 * 60, summary: "含停车 10 分钟" });
  });

  it("prefers a known fare over the meter estimate when comparing", () => {
    const pricedTaxi = taxi(20, 200);
    expect(pickOption([pricedTaxi, transit(30)], { ...DEFAULT_TRAVEL, prefer: "balanced" })?.mode).toBe("transit");
  });
});
