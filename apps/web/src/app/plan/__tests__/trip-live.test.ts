import { describe, expect, it } from "vitest";
import { estimateTrip, type TripProgressView } from "../trip-estimate";
import { platformLinks } from "../platform-links";
import { isOutdoorCategory } from "@tripquest/application/day-planning";
import { arrivalReminder, deviceToAmap, distanceTo, isWet, lateReminder, navigationUrl, rainReminder, type LivePoint } from "../trip-live";

// V2.6: synthetic places and readings only.
const HOME: readonly [number, number] = [120.1, 30.2];
const MUSEUM: readonly [number, number] = [120.11, 30.2]; // ~960 m east
const PARK: readonly [number, number] = [120.13, 30.2];
const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const view = (extra: Partial<TripProgressView> = {}): TripProgressView => ({
  journeyId: "j", conversationId: null, title: "合成一日", date: "2026-10-18", planVersion: 1, observationVersion: 0, note: null,
  window: { startsAt: 540, endsAt: 1080 }, resumeAt: 540,
  start: { name: "合成广场", point: HOME }, end: null,
  stops: [
    { activityId: "a1", name: "合成博物馆", startsAt: minute("09:30"), endsAt: minute("11:00"), status: "todo", archived: false, fixed: false, point: MUSEUM },
    { activityId: "a2", name: "合成公园", startsAt: minute("11:30"), endsAt: minute("12:30"), status: "todo", archived: false, fixed: false, point: PARK, outdoor: true, arrivalMode: "transit" },
  ],
  ...extra,
});
const at = (point: readonly [number, number], accuracy = 20, offsetMeters = 0): LivePoint =>
  ({ longitude: point[0] + offsetMeters / 96_000, latitude: point[1], accuracy, at: 0 });

describe("V2.6 live position, navigation and weather reminders", () => {
  it("converts a device point to Amap's coordinates as Amap does (checked live at public points)", () => {
    const [lng, lat] = deviceToAmap(120.1585, 30.2738);
    // Amap's own conversion of this point: 120.16318467882, 30.271465115018.
    expect(Math.abs(lng - 120.16318467882) * 96_000 + Math.abs(lat - 30.271465115018) * 111_000).toBeLessThan(0.5);
  });

  it("opens Amap's navigation with the leg's mode; a taxi leg opens driving", () => {
    const url = new URL(navigationUrl({ to: { name: "合成公园", point: PARK }, mode: "transit" }));
    expect(url.origin + url.pathname).toBe("https://uri.amap.com/navigation");
    expect(Object.fromEntries(url.searchParams)).toEqual({ to: "120.130000,30.200000,合成公园", mode: "bus", src: "tripquest", callnative: "1" });
    expect(new URL(navigationUrl({ to: { name: "x", point: PARK }, mode: "taxi" })).searchParams.get("mode")).toBe("car");
    expect(new URL(navigationUrl({ to: { name: "x", point: PARK }, from: { name: "家", point: HOME } })).searchParams.get("from")).toBe("120.100000,30.200000,家");
  });

  it("asks 'arrived?' only after two usable readings near the stop, and once", () => {
    const trip = view();
    const estimate = estimateTrip(trip, minute("09:20"), true);
    expect(distanceTo(at(HOME), MUSEUM).meters).toBeGreaterThan(900);
    const near = [at(MUSEUM, 20, 30), at(MUSEUM, 20, 50)];
    expect(arrivalReminder(trip, estimate, near, new Set())).toMatchObject({ kind: "arrived", name: "合成博物馆" });
    // One reading, a far one, or a poor fix decides nothing; a dismissed one stays quiet.
    expect(arrivalReminder(trip, estimate, near.slice(0, 1), new Set())).toBeNull();
    expect(arrivalReminder(trip, estimate, [at(HOME), at(MUSEUM)], new Set())).toBeNull();
    expect(arrivalReminder(trip, estimate, [at(MUSEUM, 150), at(MUSEUM, 150)], new Set())).toBeNull();
    expect(arrivalReminder(trip, estimate, near, new Set(["arrived:a1"]))).toBeNull();
  });

  it("warns about being late only close to the start and when the walk is clearly too long", () => {
    const trip = view();
    const estimate = estimateTrip(trip, minute("09:20"), true);
    // ~2.9 km from the park is ~41 minutes on foot.
    const done = { ...trip, stops: trip.stops.map((stop, index) => (index === 0 ? { ...stop, status: "done" as const } : stop)) };
    const afterMuseum = estimateTrip(done, minute("11:20"), true);
    expect(lateReminder(done, afterMuseum, at(HOME), minute("11:20"), new Set())).toMatchObject({ kind: "late", name: "合成公园" });
    expect(lateReminder(done, afterMuseum, at(HOME), minute("11:00"), new Set())).toBeNull(); // 30 min ahead: too early to say
    expect(lateReminder(done, afterMuseum, at(PARK, 20, 300), minute("11:20"), new Set())).toBeNull(); // close enough
    expect(lateReminder(trip, estimate, null, minute("09:20"), new Set())).toBeNull();
  });

  it("points out rain only when a stop still to come is outdoors", () => {
    expect(isWet("小雨")).toBe(true);
    expect(isWet("多云")).toBe(false);
    expect(isOutdoorCategory("110101")).toBe(true);
    expect(isOutdoorCategory("110000")).toBe(true);
    expect(isOutdoorCategory("190301")).toBe(true);
    expect(isOutdoorCategory("140100")).toBe(false);
    const wet = view({ weather: { now: "中雨", day: "中雨", night: "阴" } });
    expect(rainReminder(wet, minute("10:00"), true, new Set())).toEqual({ kind: "rain", key: "rain:2026-10-18:now", names: ["合成公园"], now: true });
    // Rain later this afternoon counts too; another day, dry weather or no outdoor stop does not.
    expect(rainReminder(view({ weather: { now: "多云", day: "雷阵雨", night: "晴" } }), minute("10:00"), true, new Set())).toMatchObject({ now: false });
    expect(rainReminder(wet, minute("10:00"), false, new Set())).toBeNull();
    expect(rainReminder(view({ weather: { now: "晴", day: "晴", night: "晴" } }), minute("10:00"), true, new Set())).toBeNull();
    expect(rainReminder(wet, minute("13:00"), true, new Set())).toBeNull(); // the park is over
    expect(rainReminder(wet, minute("10:00"), true, new Set(["rain:2026-10-18:now"]))).toBeNull();
  });
});

describe("V2.7 platform links", () => {
  it("search Xiaohongshu and Dianping (Hangzhou) by the place's name only", () => {
    const links = platformLinks("合成博物馆(西馆)");
    expect(links.map((link) => link.label)).toEqual(["小红书", "大众点评"]);
    expect(new URL(links[0].url).searchParams.get("keyword")).toBe("合成博物馆(西馆)");
    expect(decodeURIComponent(links[1].url)).toBe("https://www.dianping.com/search/keyword/3/0_合成博物馆(西馆)");
  });
});
