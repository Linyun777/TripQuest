"use client";

import type { TravelLegInput } from "@tripquest/domain";
import {
  FixtureMobilityProvider,
  createFixtureRouteRequest,
  selectedRouteToTravelLeg,
  unavailableRouteToTravelLeg,
  type FixtureRouteScenario,
  type PlaceSearchData,
  type PlaceSearchRequest,
  type ProviderEvidence,
  type ProviderResult,
  type RouteResult,
} from "@tripquest/providers";
import Link from "next/link";
import { useState } from "react";

const RETRIEVED_AT = "2026-09-21T12:00:00+08:00";

type PlaceScenario = "two_results" | "empty" | "invalid";

const placeScenarios: ReadonlyArray<readonly [PlaceScenario, string]> = [
  ["two_results", "两个同名地点"],
  ["empty", "成功但无结果"],
  ["invalid", "非法请求"],
];

const routeScenarios: ReadonlyArray<readonly [FixtureRouteScenario, string]> = [
  ["success", "成功路线"],
  ["no_route", "当前方式无路线"],
  ["timeout", "响应超时"],
  ["rate_limited", "请求限流"],
  ["quota_exceeded", "配额耗尽"],
  ["authorization_failed", "配置或权限错误"],
];

const retryLabels = {
  never: "不要自动重试",
  after_backoff: "有限退避后重试",
  after_quota_reset: "等待配额重置",
  after_configuration_change: "等待配置修复",
} as const;

function Evidence({ value }: { value: ProviderEvidence }) {
  return (
    <dl className="mt-4 grid gap-2 rounded-2xl bg-[#f4f7f3] p-4 text-sm sm:grid-cols-2">
      <div><dt className="text-[#6f7e76]">Provider</dt><dd className="mt-0.5 font-mono">{value.provider}</dd></div>
      <div><dt className="text-[#6f7e76]">数据种类</dt><dd className="mt-0.5">{value.sourceKind === "fixture" ? "fixture（虚构）" : "live"}</dd></div>
      <div><dt className="text-[#6f7e76]">获取时间</dt><dd className="mt-0.5 font-mono text-xs">{value.retrievedAt}</dd></div>
      <div><dt className="text-[#6f7e76]">来源说明</dt><dd className="mt-0.5">{value.attribution}</dd></div>
    </dl>
  );
}

function ScenarioChoices<T extends string>({
  legend,
  choices,
  value,
  onChange,
}: {
  legend: string;
  choices: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-[#425c50]">{legend}</legend>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {choices.map(([key, label]) => (
          <label
            key={key}
            className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors ${
              value === key ? "border-[#236d55] bg-[#edf6f0] text-[#195740]" : "border-[#d9e5dc] bg-white hover:bg-[#f8faf8]"
            }`}
          >
            <input
              type="radio"
              name={legend}
              checked={value === key}
              onChange={() => onChange(key)}
              className="accent-[#236d55]"
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function DomainLeg({ leg }: { leg: TravelLegInput }) {
  return (
    <div className="mt-4 rounded-2xl border border-[#bcd6c6] bg-[#eff7f1] p-4 text-sm">
      <p className="font-medium">传给 S2 的交通输入</p>
      <p className="mt-2 font-mono text-xs leading-6">
        {leg.fromPlaceId} → {leg.toPlaceId} · {leg.duration.kind}
        {leg.duration.kind === "known" ? ` · ${leg.duration.minutes} 分钟` : ` · ${leg.duration.reason}`}
      </p>
    </div>
  );
}

function PlaceResult({ result }: { result: ProviderResult<PlaceSearchData> }) {
  return (
    <div className="mt-5 border-t border-[#e2ebe5] pt-5" aria-live="polite">
      {result.status === "failure" ? (
        <div className="rounded-2xl bg-[#fff4e8] p-4">
          <p className="font-semibold">failure · {result.failure.code}</p>
          <p className="mt-2 text-sm leading-6">{result.failure.safeMessage}</p>
          <p className="mt-1 text-sm">建议：{retryLabels[result.failure.retry]}</p>
        </div>
      ) : result.data.items.length === 0 ? (
        <div className="rounded-2xl bg-[#f4f7f3] p-4">
          <p className="font-semibold">ok · 0 个结果</p>
          <p className="mt-2 text-sm text-[#607269]">查询成功，只是没有匹配地点；它不是 provider failure。</p>
        </div>
      ) : (
        <div>
          <p className="font-semibold">ok · {result.data.items.length} 个独立地点</p>
          <ul className="mt-3 grid gap-3">
            {result.data.items.map((place) => (
              <li key={place.ref.externalId} className="rounded-2xl border border-[#d9e5dc] p-4 text-sm">
                <p className="font-semibold">{place.name}</p>
                <p className="mt-1 text-[#607269]">{place.address}</p>
                <p className="mt-2 font-mono text-xs">{place.ref.provider}:{place.ref.externalId}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Evidence value={result.evidence} />
    </div>
  );
}

function RouteResultView({ result, leg }: { result: RouteResult; leg: TravelLegInput }) {
  return (
    <div className="mt-5 border-t border-[#e2ebe5] pt-5" aria-live="polite">
      {result.status === "ok" ? (
        <div className="rounded-2xl bg-[#eff7f1] p-4">
          <p className="font-semibold">ok · 已明确选择第 1 条虚构路线</p>
          <p className="mt-2 text-sm leading-6">
            {result.routes[0].durationSeconds} 秒 ÷ 60，向上取整为 <strong>{leg.duration.kind === "known" && leg.duration.minutes} 分钟</strong>；
            距离 {result.routes[0].distanceMeters} 米。
          </p>
        </div>
      ) : result.status === "no_route" ? (
        <div className="rounded-2xl bg-[#fff4e8] p-4">
          <p className="font-semibold">no_route · {result.reason}</p>
          <p className="mt-2 text-sm leading-6">接口语义是当前交通方式没有路线，不是超时，也不会生成 0 分钟。</p>
        </div>
      ) : (
        <div className="rounded-2xl bg-[#fff4e8] p-4">
          <p className="font-semibold">failure · {result.failure.code}</p>
          <p className="mt-2 text-sm leading-6">{result.failure.safeMessage}</p>
          <p className="mt-1 text-sm">建议：{retryLabels[result.failure.retry]}</p>
          {result.failure.retryAfterSeconds !== undefined && (
            <p className="mt-1 text-sm">最少等待 {result.failure.retryAfterSeconds} 秒</p>
          )}
        </div>
      )}
      <DomainLeg leg={leg} />
      <Evidence value={result.evidence} />
    </div>
  );
}

function placeRequestFor(scenario: PlaceScenario): PlaceSearchRequest {
  return {
    query: scenario === "two_results" ? "下午馆" : scenario === "empty" ? "不存在" : " ",
    limit: scenario === "invalid" ? 0 : 10,
    scope: { kind: "city", cityAdcode: "000000" },
  };
}

export default function ProvidersLab() {
  const [placeScenario, setPlaceScenario] = useState<PlaceScenario>("two_results");
  const [routeScenario, setRouteScenario] = useState<FixtureRouteScenario>("success");
  const [placeResult, setPlaceResult] = useState<ProviderResult<PlaceSearchData> | null>(null);
  const [routeResult, setRouteResult] = useState<RouteResult | null>(null);
  const [domainLeg, setDomainLeg] = useState<TravelLegInput | null>(null);
  const [pending, setPending] = useState<"place" | "route" | null>(null);

  const runPlace = async () => {
    setPending("place");
    try {
      const provider = new FixtureMobilityProvider({ now: () => RETRIEVED_AT });
      setPlaceResult(await provider.searchPlaces(placeRequestFor(placeScenario)));
    } finally {
      setPending(null);
    }
  };

  const runRoute = async () => {
    setPending("route");
    try {
      const provider = new FixtureMobilityProvider({ now: () => RETRIEVED_AT, routeScenario });
      const result = await provider.findRoutes(createFixtureRouteRequest());
      const leg = result.status === "ok"
        ? selectedRouteToTravelLeg("P-C", "P-D", result.routes[0])
        : unavailableRouteToTravelLeg("P-C", "P-D", result);
      setRouteResult(result);
      setDomainLeg(leg);
    } finally {
      setPending(null);
    }
  };

  return (
    <main className="min-h-dvh bg-[#f7f9f7] px-5 py-7 text-[#21352e] sm:px-8 sm:py-10">
      <div className="mx-auto max-w-3xl">
        <header className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-[0.18em] text-[#4f806e]">TRIPQUEST · 本地实验</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">地点与路线 Provider</h1>
          </div>
          <Link href="/" className="shrink-0 text-sm font-medium text-[#236d55] underline-offset-4 hover:underline">返回首页</Link>
        </header>

        <div className="mt-6 rounded-3xl border border-[#cfe0d4] bg-[#edf6f0] p-5 text-sm leading-7">
          <p className="font-semibold">这里全部是虚构数据</p>
          <p className="mt-1 text-[#536c60]">没有真实 API、地图 Key 或商户信息；操作不会保存。杭州实时验证请切换上方数据来源。</p>
        </div>

        <section className="mt-6 rounded-3xl border border-[#dce8e0] bg-white p-5 shadow-[0_14px_36px_-30px_rgba(22,57,42,0.45)] sm:p-6" aria-labelledby="places-heading">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold text-[#4f806e]">01 · PLACE SEARCH</p>
              <h2 id="places-heading" className="mt-1 text-xl font-semibold">地点查询结果不是一个布尔值</h2>
            </div>
            <span className="rounded-full bg-[#f1f6f2] px-3 py-1 text-xs text-[#4f6d5f]">虚构市 · 000000</span>
          </div>
          <div className="mt-5">
            <ScenarioChoices
              legend="选择地点场景"
              choices={placeScenarios}
              value={placeScenario}
              onChange={(value) => { setPlaceScenario(value); setPlaceResult(null); }}
            />
          </div>
          <button
            type="button"
            onClick={() => void runPlace()}
            disabled={pending !== null}
            className="mt-5 w-full rounded-xl bg-[#236d55] px-4 py-3 font-medium text-white hover:bg-[#195740] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === "place" ? "查询中…" : "运行地点查询"}
          </button>
          {placeResult ? <PlaceResult result={placeResult} /> : <p className="mt-4 text-sm text-[#6f7e76]">运行后查看多结果、成功空结果或失败。</p>}
        </section>

        <section className="mt-6 rounded-3xl border border-[#dce8e0] bg-white p-5 shadow-[0_14px_36px_-30px_rgba(22,57,42,0.45)] sm:p-6" aria-labelledby="routes-heading">
          <div>
            <p className="text-xs font-semibold text-[#4f806e]">02 · ROUTE ESTIMATE</p>
            <h2 id="routes-heading" className="mt-1 text-xl font-semibold">无路线与暂时查不到需要分开</h2>
            <p className="mt-2 text-sm leading-6 text-[#607269]">固定请求：P-C → P-D · walking。成功路线为 2400 秒，转换前由调用方明确选择。</p>
          </div>
          <div className="mt-5">
            <ScenarioChoices
              legend="选择路线场景"
              choices={routeScenarios}
              value={routeScenario}
              onChange={(value) => { setRouteScenario(value); setRouteResult(null); setDomainLeg(null); }}
            />
          </div>
          <button
            type="button"
            onClick={() => void runRoute()}
            disabled={pending !== null}
            className="mt-5 w-full rounded-xl bg-[#236d55] px-4 py-3 font-medium text-white hover:bg-[#195740] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === "route" ? "查询中…" : "运行路线查询"}
          </button>
          {routeResult && domainLeg
            ? <RouteResultView result={routeResult} leg={domainLeg} />
            : <p className="mt-4 text-sm text-[#6f7e76]">运行后查看规范化状态、重试建议和传给 S2 的交通输入。</p>}
        </section>

        <p className="mt-6 text-center text-xs leading-6 text-[#829188]">TripQuest S3.1 · fixture contract lab · 不代表已接入高德</p>
      </div>
    </main>
  );
}
