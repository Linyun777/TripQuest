"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SavedDayFacts } from "@tripquest/application/saved-day";
import type { PlanningMapConfig } from "./map-config";
import {
  groupMapNodes,
  mountPlanningMap,
  updateMapOverlays,
  type MapNode,
  type AmapApi,
  type AmapInstance,
} from "./amap-loader";

/** Start → activities → end; a saved draft, a stored v3 or a replan candidate all fit. */
export interface DayMapRoute {
  readonly startPlace: { readonly placeId: string };
  readonly endPlace: { readonly placeId: string };
  readonly activities: readonly { readonly activityId: string; readonly placeId: string }[];
}

export function DayMap({
  draft,
  places,
  selected,
  onSelect,
  config,
}: {
  draft: DayMapRoute;
  places: readonly Pick<SavedDayFacts["places"][number], "placeId" | "selection">[];
  selected: string;
  onSelect: (id: string) => void;
  config: PlanningMapConfig;
}) {
  const nodes = useMemo(() => {
    const node = (id: string, label: string, placeId: string): MapNode => {
      const place = places.find((item) => item.placeId === placeId)!.selection
        .place;
      return {
        id,
        label,
        name: place.name,
        position: [place.location.longitude, place.location.latitude],
      };
    };
    return [
      node("start", "起", draft.startPlace.placeId),
      ...draft.activities.map((activity, index) =>
        node(
          `activity:${activity.activityId}`,
          String(index + 1),
          activity.placeId,
        ),
      ),
      node("end", "终", draft.endPlace.placeId),
    ];
  }, [draft, places]);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<
    "schematic" | "loading" | "ready" | "error"
  >("schematic");
  const container = useRef<HTMLDivElement>(null);
  const current = useRef<{ api: AmapApi; map: AmapInstance } | null>(null);
  const mapKey = config.mode === "amap" ? config.key : "";
  const serviceHost = config.mode === "amap" ? config.serviceHost : "";

  useEffect(() => {
    if (!attempt || !mapKey || !container.current) return;
    const dispose = mountPlanningMap({
      container: container.current,
      key: mapKey,
      serviceHost,
      center: nodes[0].position,
      onReady: (api, map) => {
        current.current = { api, map };
        setStatus("ready");
      },
      onError: () => {
        current.current = null;
        setStatus("error");
      },
    });
    return () => {
      current.current = null;
      dispose();
    };
    // Selection and candidate changes update overlays below; keep one map instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, mapKey, serviceHost]);

  useEffect(() => {
    if (status !== "ready" || !current.current) return;
    const { api, map } = current.current;
    const remove = updateMapOverlays(api, map, nodes, onSelect);
    return () => {
      if (current.current?.map === map) remove();
    };
  }, [nodes, onSelect, status]);
  useEffect(() => {
    const node = nodes.find((item) => item.id === selected);
    if (node && current.current) current.current.map.setCenter(node.position);
  }, [nodes, selected]);

  const groups = groupMapNodes(nodes);
  const xs = nodes.map((node) => node.position[0]);
  const ys = nodes.map((node) => node.position[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const position = (node: MapNode) => ({
    x:
      minX === maxX
        ? 200
        : 36 + ((node.position[0] - minX) / (maxX - minX)) * 328,
    y:
      minY === maxY
        ? 120
        : 204 - ((node.position[1] - minY) / (maxY - minY)) * 168,
  });
  return (
    <section
      aria-label="地点与访问顺序"
      className="mt-6 rounded-3xl border border-[#dce8e0] bg-white p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">地点与访问顺序</h2>
        {config.mode === "amap" && status !== "ready" && (
          <button
            type="button"
            disabled={status === "loading"}
            onClick={() => {
              setStatus("loading");
              setAttempt((value) => value + 1);
            }}
            className="min-h-11 rounded-xl border border-[#b8cfc0] px-4 text-sm"
          >
            {status === "loading"
              ? "底图加载中…"
              : status === "error"
                ? "重试高德底图"
                : "加载高德底图"}
          </button>
        )}
      </div>
      <p className="mt-2 text-sm leading-6 text-[#52665c]">
        {status === "ready"
          ? "高德底图；标记为虚构演示地点，连线仅表示访问顺序。"
          : "离线地点示意；坐标与名称均为演示数据，连线仅表示访问顺序。"}
        步行估计来自本地演示路线。
      </p>
      {status === "error" && (
        <p role="status" className="mt-2 text-sm text-[#8f392e]">
          高德底图暂不可用，仍可查看示意和修改行程。
        </p>
      )}
      <div
        ref={container}
        hidden={!attempt || status === "error"}
        className="mt-4 h-72 overflow-hidden rounded-2xl"
      />
      {status !== "ready" && (
        <svg
          viewBox="0 0 400 240"
          role="img"
          aria-label="演示地点顺序示意"
          className="mt-4 w-full rounded-2xl bg-[#f1f7f2]"
        >
          <polyline
            fill="none"
            stroke="#93b5a3"
            strokeWidth="2"
            strokeDasharray="6 5"
            points={nodes
              .map((node) => {
                const p = position(node);
                return `${p.x},${p.y}`;
              })
              .join(" ")}
          />
          {groups.map((group) => {
            const p = position(group[0]);
            const active = group.some((node) => node.id === selected);
            return (
              <g
                key={group[0].id}
                role="button"
                tabIndex={0}
                aria-label={`选择${group.map((node) => `${node.label} ${node.name}`).join("、")}`}
                onClick={() => onSelect(group[0].id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(group[0].id);
                  }
                }}
                className="cursor-pointer focus:outline-2"
              >
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={group.length > 1 ? 27 : 21}
                  fill={active ? "#b88362" : "#236d55"}
                />
                <text
                  x={p.x}
                  y={p.y + 5}
                  textAnchor="middle"
                  fill="white"
                  fontSize="13"
                >
                  {group.map((node) => node.label).join("/")}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <div className="mt-4 flex flex-wrap gap-2" aria-label="选择时间线地点">
        {nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            aria-pressed={selected === node.id}
            onClick={() => onSelect(node.id)}
            className={`min-h-11 rounded-xl border px-3 text-sm ${selected === node.id ? "border-[#236d55] bg-[#e6f2eb]" : "border-[#dce8e0]"}`}
          >
            {node.label} · {node.name}
          </button>
        ))}
      </div>
    </section>
  );
}
