"use client";

export interface MapOverlay {
  /** Markers only: move without redrawing (V2.6 live dot). */
  setPosition?(position: [number, number]): void;
  on(type: string, listener: () => void): void;
}
export interface AmapInstance {
  on(type: string, listener: () => void): void;
  off(type: string, listener: () => void): void;
  add(overlays: MapOverlay[]): void;
  remove(overlays: MapOverlay[]): void;
  setFitView(
    overlays: MapOverlay[],
    immediately?: boolean,
    avoid?: [number, number, number, number],
    maxZoom?: number,
  ): void;
  setCenter(position: [number, number]): void;
  destroy(): void;
}
export interface AmapApi {
  Map: new (
    container: HTMLElement,
    options: { zoom: number; center: [number, number]; mapStyle?: string },
  ) => AmapInstance;
  Marker: new (options: {
    position: [number, number];
    content: HTMLElement;
    anchor: string;
  }) => MapOverlay;
  Polyline: new (options: {
    path: [number, number][];
    strokeColor: string;
    strokeWeight: number;
    strokeStyle: string;
  }) => MapOverlay;
}

let pending: Promise<AmapApi> | null = null;
export function loadPlanningMap(
  key: string,
  serviceHost: string,
): Promise<AmapApi> {
  if (pending) return pending;
  (
    window as Window & { _AMapSecurityConfig?: { serviceHost: string } }
  )._AMapSecurityConfig = {
    serviceHost: new URL(serviceHost, window.location.origin).href,
  };
  pending = import("@amap/amap-jsapi-loader")
    .then(async ({ default: loader }) => {
      try {
        return (await loader.load({
          key,
          version: "2.0",
          plugins: [],
        })) as AmapApi;
      } catch {
        // The official runtime exports reset, but 1.0.1's declaration omits it.
        (loader as typeof loader & { reset(): void }).reset();
        throw new Error("Map unavailable");
      }
    })
    .catch(() => {
      pending = null;
      throw new Error("Map unavailable");
    });
  return pending;
}

/** One mounted map owns its completion listener and timeout, including late SDK results. */
export function mountPlanningMap(options: {
  container: HTMLElement;
  key: string;
  serviceHost: string;
  center: [number, number];
  onReady: (api: AmapApi, map: AmapInstance) => void;
  onError: () => void;
}): () => void {
  let closed = false;
  let map: AmapInstance | undefined;
  const ready = () => {
    if (closed || !map) return;
    clearTimeout(timeout);
    map.off("complete", ready);
    options.onReady(api!, map);
  };
  let api: AmapApi | undefined;
  const dispose = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    map?.off("complete", ready);
    map?.destroy();
  };
  const fail = () => {
    dispose();
    options.onError();
  };
  const timeout = setTimeout(fail, 15000);
  void loadPlanningMap(options.key, options.serviceHost)
    .then((loaded) => {
      if (closed) return;
      api = loaded;
      map = new api.Map(options.container, {
        zoom: 14,
        center: options.center,
        // A quiet built-in style so the plan's markers stand out over the city.
        mapStyle: "amap://styles/whitesmoke",
      });
      map.on("complete", ready);
    })
    .catch(() => {
      if (!closed) fail();
    });
  return dispose;
}

/** A real route line to draw; colour and dash come from the caller (by travel mode). */
export interface MapLine {
  readonly points: readonly (readonly [number, number])[];
  readonly color: string;
  readonly dashed: boolean;
}

export function updateMapOverlays(
  api: AmapApi,
  map: AmapInstance,
  nodes: readonly MapNode[],
  select: (id: string) => void,
  lines: readonly MapLine[] = [],
  /** V2.4: candidates are alternatives, not a route: no order line between them. */
  connect = true,
) {
  const groups = groupMapNodes(nodes);
  const overlays: MapOverlay[] = groups.map((group) => {
    const content = document.createElement("div");
    const endpoint = group.every((node) => node.label === "起" || node.label === "终");
    content.className = [
      "flex gap-0.5 rounded-full border-[2.5px] border-white p-0.5 text-[13px] text-white",
      "shadow-[0_4px_12px_rgb(23_33_29/0.28)]",
      endpoint ? "bg-ink" : "bg-lake-600",
    ].join(" ");
    for (const node of group) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = node.label;
      button.setAttribute("aria-label", `${node.label} · ${node.name}`);
      button.className =
        "min-h-7 min-w-7 rounded-full px-1.5 font-semibold focus:outline-2";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        select(node.id);
      });
      content.append(button);
    }
    return new api.Marker({
      position: group[0].position,
      content,
      anchor: "bottom-center",
    });
  });
  if (lines.length) {
    // V2.2: the real route of each leg, styled by how it is travelled.
    for (const line of lines) {
      overlays.push(new api.Polyline({
        path: line.points.map(([longitude, latitude]) => [longitude, latitude]),
        strokeColor: line.color,
        strokeWeight: line.dashed ? 3 : 5,
        strokeStyle: line.dashed ? "dashed" : "solid",
      }));
    }
  } else if (connect) {
    overlays.push(
      new api.Polyline({
        path: nodes.map((node) => node.position),
        strokeColor: "#2f8a6f",
        strokeWeight: 3,
        strokeStyle: "dashed",
      }),
    );
  }
  map.add(overlays);
  // Leave room around the markers and never zoom in past street level.
  map.setFitView(overlays, true, [56, 56, 56, 56], 16);
  return () => map.remove(overlays);
}

export interface MapNode {
  id: string;
  label: string;
  name: string;
  position: [number, number];
}
export function groupMapNodes(nodes: readonly MapNode[]): MapNode[][] {
  const groups = new Map<string, MapNode[]>();
  for (const node of nodes) {
    const key = JSON.stringify(node.position);
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  return [...groups.values()];
}
