"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  mountPlanningMap,
  updateMapOverlays,
  type AmapApi,
  type AmapInstance,
  type MapNode,
} from "../journeys/amap-loader";
import type { PlanningMapConfig } from "../journeys/map-config";
import { MODE_STYLE } from "./plan-card";
import type { MapPath, MapStop } from "./view-models";
import { EASE_OUT } from "../_ui/motion";

/**
 * 按访问顺序展示地点；配置 JS Key 后加载高德底图，加载中或失败时保留示意图。
 * 缺少实际路线时，连线只说明访问顺序，不能当作道路导航。
 */
export function PlanMap({
  stops,
  paths = [],
  config,
  selected,
  onSelect,
  connect = true,
}: {
  stops: readonly MapStop[];
  /** 有实际路线时按交通方式画线；缺少路线数据才按站点顺序连线。 */
  paths?: readonly MapPath[];
  config: PlanningMapConfig;
  selected?: string;
  onSelect?: (key: string) => void;
  /** 短途候选互为备选而非访问顺序，因此关闭候选之间的连线。 */
  connect?: boolean;
}) {
  const nodes = useMemo<MapNode[]>(
    () => stops.map((stop) => ({
      id: stop.key,
      label: stop.label,
      name: stop.name,
      position: [stop.longitude, stop.latitude],
    })),
    [stops],
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const container = useRef<HTMLDivElement>(null);
  const current = useRef<{ api: AmapApi; map: AmapInstance } | null>(null);
  const mapKey = config.mode === "amap" ? config.key : "";
  const serviceHost = config.mode === "amap" ? config.serviceHost : "";
  const select = useMemo(() => onSelect ?? (() => {}), [onSelect]);

  useEffect(() => {
    if (!mapKey || !container.current || nodes.length === 0) return;
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
    // 覆盖物在下方单独更新，每个 Key 只维护一个地图实例。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapKey, serviceHost]);

  // 地图实例与业务覆盖物分开管理：站点、路线或选择回调变化时只替换覆盖物，
  // 不重建整个 SDK 地图，避免视角丢失和旧事件监听残留。
  useEffect(() => {
    if (status !== "ready" || !current.current) return;
    const { api, map } = current.current;
    const lines = paths.map((path) => ({
      points: path.points,
      color: MODE_STYLE[path.mode].color,
      dashed: path.mode === "walking",
    }));
    const remove = updateMapOverlays(api, map, nodes, select, lines, connect);
    return () => {
      if (current.current?.map === map) remove();
    };
  }, [nodes, paths, select, status, connect]);

  const live = config.mode === "amap" && status === "ready";
  return (
    <div className="relative overflow-hidden rounded-(--radius-card) border border-line bg-lake-50">
      {/** 容器初始就有明确尺寸，避免地图按零尺寸计算缩放范围后无法正确适配标记。 */}
      <div ref={container} className="h-80 w-full" />
      {!live && (
        <div className="absolute inset-0 bg-lake-50">
          <Schematic stops={stops} selected={selected} onSelect={onSelect} connect={connect} />
        </div>
      )}
      <p className="absolute left-3 top-3 rounded-full bg-surface/85 px-2.5 py-0.5 text-[11px] text-ink-faint backdrop-blur">
        {!connect
          ? (live ? "高德地图 · 候选位置" : "示意图 · 候选位置")
          : live ? (paths.length ? "高德地图 · 实际路线" : "高德地图 · 连线仅表示顺序") : status === "error" ? "底图暂不可用 · 示意图" : "示意图 · 连线仅表示顺序"}
      </p>
    </div>
  );
}

function Schematic({
  stops,
  selected,
  onSelect,
  connect = true,
}: {
  stops: readonly MapStop[];
  selected?: string;
  onSelect?: (key: string) => void;
  connect?: boolean;
}) {
  if (stops.length === 0) {
    return <div className="grid h-80 place-items-center text-sm text-ink-faint">方案生成后在这里显示地点</div>;
  }
  const xs = stops.map((stop) => stop.longitude);
  const ys = stops.map((stop) => stop.latitude);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const point = (stop: MapStop) => ({
    x: minX === maxX ? 200 : 40 + ((stop.longitude - minX) / (maxX - minX)) * 320,
    y: minY === maxY ? 150 : 260 - ((stop.latitude - minY) / (maxY - minY)) * 220,
  });
  const path = stops.map((stop) => point(stop)).map((p) => `${p.x},${p.y}`).join(" ");
  return (
    <svg viewBox="0 0 400 300" role="img" aria-label="地点访问顺序示意" className="h-80 w-full">
      <defs>
        <pattern id="plan-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M24 0H0V24" fill="none" stroke="var(--color-lake-100)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="400" height="300" fill="url(#plan-grid)" />
      {connect && <motion.polyline
        points={path}
        fill="none"
        stroke="var(--color-lake-500)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="1 7"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.1, ease: EASE_OUT }}
      />}
      {stops.map((stop, index) => {
        const p = point(stop);
        const active = selected === stop.key;
        const endpoint = stop.kind !== "stop";
        return (
          <motion.g
            key={stop.key}
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.12 * index, type: "spring", stiffness: 380, damping: 22 }}
            style={{ transformOrigin: `${p.x}px ${p.y}px` }}
            onClick={() => onSelect?.(stop.key)}
            className={onSelect ? "cursor-pointer" : undefined}
          >
            <circle
              cx={p.x}
              cy={p.y}
              r={endpoint ? 13 : 15}
              fill={endpoint ? "var(--color-ink)" : active ? "var(--color-sun-500)" : "var(--color-lake-600)"}
              stroke="white"
              strokeWidth="3"
            />
            <text x={p.x} y={p.y + 4.5} textAnchor="middle" fontSize="12" fontWeight="600" fill="white">
              {stop.label}
            </text>
            <text x={p.x} y={p.y + 32} textAnchor="middle" fontSize="11" fill="var(--color-ink-soft)">
              {stop.name.length > 8 ? `${stop.name.slice(0, 8)}…` : stop.name}
            </text>
          </motion.g>
        );
      })}
    </svg>
  );
}
