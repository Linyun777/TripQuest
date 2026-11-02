import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AmapInstance } from "../amap-loader";

const loader = vi.hoisted(() => ({ load: vi.fn(), reset: vi.fn() }));
vi.mock("@amap/amap-jsapi-loader", () => ({ default: loader }));

function fakeSdk() {
  const instances: FakeMap[] = [];
  class FakeMap implements AmapInstance {
    listener?: () => void;
    on = vi.fn((_type: string, listener: () => void) => {
      this.listener = listener;
    });
    off = vi.fn();
    add = vi.fn();
    remove = vi.fn();
    setFitView = vi.fn();
    setCenter = vi.fn();
    destroy = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  const overlay = class {
    on = vi.fn();
  };
  return {
    instances,
    api: { Map: FakeMap, Marker: overlay, Polyline: overlay },
  };
}
beforeEach(() => {
  vi.resetModules();
  loader.load.mockReset();
  loader.reset.mockReset();
  vi.stubGlobal("window", { location: { origin: "http://localhost:3354" } });
  vi.stubGlobal("document", {
    createElement: () => ({
      append: vi.fn(),
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
    }),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("loads SDK once, updates/removes overlays in the same instance and releases its listener/map on unmount", async () => {
  const sdk = fakeSdk();
  loader.load.mockResolvedValue(sdk.api);
  const { loadPlanningMap, mountPlanningMap, updateMapOverlays } = await import(
    "../amap-loader"
  );
  const onReady = vi.fn();
  const dispose = mountPlanningMap({
    container: {} as HTMLElement,
    key: "fixture-key",
    serviceHost: "/_AMapService",
    center: [120.1, 30.2],
    onReady,
    onError: vi.fn(),
  });
  await loadPlanningMap("fixture-key", "/_AMapService");
  await loadPlanningMap("fixture-key", "/_AMapService");
  expect(loader.load).toHaveBeenCalledTimes(1);
  expect((window as Window & { _AMapSecurityConfig?: unknown })._AMapSecurityConfig).toEqual({
    serviceHost: "http://localhost:3354/_AMapService",
  });
  expect(sdk.instances).toHaveLength(1);
  const map = sdk.instances[0];
  map.listener!();
  expect(onReady).toHaveBeenCalledWith(sdk.api, map);
  const current = [
    {
      id: "start",
      label: "起",
      name: "演示起点",
      position: [120.1, 30.2] as [number, number],
    },
  ];
  const removeCurrent = updateMapOverlays(sdk.api, map, current, vi.fn());
  removeCurrent();
  const removeCandidate = updateMapOverlays(
    sdk.api,
    map,
    [
      ...current,
      {
        id: "activity:a",
        label: "1",
        name: "演示花园",
        position: [120.2, 30.3],
      },
    ],
    vi.fn(),
  );
  removeCandidate();
  expect(map.add).toHaveBeenCalledTimes(2);
  expect(map.remove.mock.calls.map(([items]) => items.length)).toEqual([2, 3]);
  expect(sdk.instances).toHaveLength(1);
  dispose();
  dispose();
  expect(map.destroy).toHaveBeenCalledTimes(1);
  expect(map.off).toHaveBeenCalledWith("complete", map.listener);
});

it("falls back on timeout, ignores a late SDK for the closed view, then reuses it on a manual retry", async () => {
  vi.useFakeTimers();
  const sdk = fakeSdk();
  let resolveSdk!: (value: typeof sdk.api) => void;
  loader.load.mockReturnValue(
    new Promise((resolve) => {
      resolveSdk = resolve;
    }),
  );
  const { loadPlanningMap, mountPlanningMap } = await import("../amap-loader");
  const onError = vi.fn();
  const onReady = vi.fn();
  const options = {
    container: {} as HTMLElement,
    key: "fixture-key",
    serviceHost: "/_AMapService",
    center: [120.1, 30.2] as [number, number],
    onReady,
    onError,
  };
  const dispose = mountPlanningMap(options);
  await vi.advanceTimersByTimeAsync(15000);
  expect(onError).toHaveBeenCalledTimes(1);
  resolveSdk(sdk.api);
  await loadPlanningMap("fixture-key", "/_AMapService");
  expect(sdk.instances).toHaveLength(0);
  expect(onReady).not.toHaveBeenCalled();
  dispose();
  const retry = mountPlanningMap(options);
  await loadPlanningMap("fixture-key", "/_AMapService");
  sdk.instances[0].listener!();
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(loader.load).toHaveBeenCalledTimes(1);
  retry();
});
