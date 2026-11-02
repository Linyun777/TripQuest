"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { selectedRouteToTravelLeg, unavailableRouteToTravelLeg, type PlaceSummary, type ProviderEvidence } from "@tripquest/providers";
import { searchLivePlaces, findLiveWalkingRoute } from "./actions";
import type { LiveConfiguration, SearchReply, RouteReply } from "./live-types";

const button = "rounded-xl bg-[#236d55] px-4 py-3 text-sm font-medium text-white disabled:opacity-50";
const retryLabels = { never: "检查输入后再查询", after_backoff: "稍后手动重试", after_quota_reset: "等待配额恢复", after_configuration_change: "检查服务配置或权限" };
function Evidence({ value }: { value: ProviderEvidence }) {
  return <p className="mt-3 break-words text-xs leading-6 text-[#607269]">{value.attribution} · 实时请求<br />应用获取时间：{value.retrievedAt}（不是上游更新日期）</p>;
}
export default function LiveLab({ configuration }: { configuration: LiveConfiguration }) {
  const [queries, setQueries] = useState(["", ""]);
  const [places, setPlaces] = useState<(PlaceSummary | null)[]>([null, null]);
  const [searches, setSearches] = useState<(SearchReply | null)[]>([null, null]);
  const [route, setRoute] = useState<RouteReply | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  // Invalidate on every input/selection change, including while a server call is pending.
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);
  const invalidate = () => { revision.current++; setRoute(null); setSelected(null); setError(""); };
  const search = (index: number) => {
    invalidate();
    setPlaces((v) => v.map((p, i) => i === index ? null : p));
    setSearches((v) => v.map((p, i) => i === index ? null : p));
    const ticket = revision.current;
    startTransition(async () => {
      try {
        const result = await searchLivePlaces(queries[index]);
        if (ticket === revision.current) setSearches((v) => v.map((p, i) => i === index ? result : p));
      } catch { if (ticket === revision.current) setError("请求未完成，请手动重试；没有使用虚构数据替代。"); }
    });
  };
  const queryRoute = () => {
    invalidate();
    const ticket = revision.current;
    startTransition(async () => {
      try {
        const result = await findLiveWalkingRoute(places[0], places[1]);
        if (ticket === revision.current) setRoute(result);
      } catch { if (ticket === revision.current) setError("请求未完成，请手动重试；路线仍为 unknown。"); }
    });
  };
  const result = route?.status === "result" ? route.result : null;
  const leg = result && places[0] && places[1] ? result.status !== "ok"
    ? unavailableRouteToTravelLeg("lab-origin", "lab-destination", result)
    : selected !== null ? selectedRouteToTravelLeg("lab-origin", "lab-destination", result.routes[selected]) : null : null;
  return <section className="mx-auto max-w-3xl rounded-3xl border border-[#dce8e0] bg-white p-5 text-[#21352e] sm:p-6">
    <h1 className="text-2xl font-semibold">杭州实时验证</h1>
    <p className="mt-3 text-sm leading-7">查询时获取的步行估计，不支持指定未来出发时刻。明确选点后查询，选路后才转换分钟。仅临时展示，不保存为正式行程。</p>
    {configuration !== "ready" ? <div role="status" className="mt-5 rounded-xl bg-[#fff4e8] p-4 text-sm leading-7">
      <p className="font-semibold">未配置实时服务</p>
      <p>{configuration === "missing_key" ? "尚未配置高德 Web 服务 Key。" : "实时查询默认关闭。"} 在本地根 .env 配置 AMAP_WEB_SERVICE_KEY 和 AMAP_LIVE_ENABLED=true，重启开发服务。</p>
      <p>Key 不要发送到聊天。启用前请核对账号端点权限和临时展示条件；原虚构实验仍可使用。</p>
    </div> : <>
      <p className="mt-3 text-sm text-[#607269]">高德地图 · 杭州。每次点击最多一次请求，无自动重试。首轮最多 20 次，权限或配额失败后停止。</p>
      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        {["起点", "终点"].map((label, index) => {
          const reply = searches[index];
          const found = reply?.status === "result" ? reply.result : null;
          return <div key={label} className="min-w-0">
            <label className="text-sm font-semibold" htmlFor={`live-place-${index}`}>{label}名称</label>
            <input id={`live-place-${index}`} value={queries[index]} maxLength={80} onChange={(e) => {
              invalidate(); setQueries((v) => v.map((q, i) => i === index ? e.target.value : q));
              setPlaces((v) => v.map((p, i) => i === index ? null : p)); setSearches((v) => v.map((p, i) => i === index ? null : p));
            }} className="mt-2 w-full rounded-xl border border-[#cfe0d4] px-3 py-3" />
            <button className={`${button} mt-3 w-full`} disabled={pending || !queries[index].trim()} onClick={() => search(index)}>搜索{label}</button>
            <div aria-live="polite" className="mt-3 text-sm">
              {reply?.status === "unavailable" && <p>{reply.message}</p>}
              {found?.status === "failure" && <p>请求失败 · {found.failure.code}<br />{found.failure.safeMessage} {retryLabels[found.failure.retry]}</p>}
              {found?.status === "ok" && <fieldset><legend>明确选择{label}（{found.data.items.length} 项）</legend>
                {found.data.items.length === 0 && <p className="mt-2">查询成功，没有匹配地点。</p>}
                {found.data.items.map((p) => <label key={p.ref.externalId} className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[#dce8e0] p-3">
                  <input className="mt-1 accent-[#236d55]" type="radio" name={`live-${index}`} checked={places[index]?.ref.externalId === p.ref.externalId} onChange={() => { invalidate(); setPlaces((v) => v.map((x, i) => i === index ? p : x)); }} />
                  <span className="min-w-0 break-words"><strong>{p.name}</strong><br />{p.address ?? "地址未提供"}<br /><span className="text-xs">{p.ref.externalId}</span></span>
                </label>)}
                {found.data.truncated && <p className="mt-2">有未展示结果，请细化名称；这里只查第一页。</p>}
              </fieldset>}
              {found && <Evidence value={found.evidence} />}
            </div>
          </div>;
        })}
      </div>
      <button className={`${button} mt-6 w-full`} disabled={pending || !places[0] || !places[1] || places[0].ref.externalId === places[1].ref.externalId} onClick={queryRoute}>查询步行路线</button>
      <div aria-live="polite" className="mt-4 text-sm leading-7">
        {pending && <p>请求中…修改输入会弃用旧结果。</p>}{error && <p>{error}</p>}
        {route?.status === "unavailable" && <p>{route.message}</p>}
        {result?.status === "failure" && <p>请求失败 · {result.failure.code}<br />{result.failure.safeMessage} {retryLabels[result.failure.retry]}{result.failure.retryAfterSeconds !== undefined && `（至少 ${result.failure.retryAfterSeconds} 秒）`}</p>}
        {result?.status === "no_route" && <p>{result.reason === "unsupported_mode" ? "适配器尚不支持此交通方式。" : "本次未找到步行路线。"}</p>}
        {result?.status === "ok" && <fieldset><legend>请选择路线以转换领域分钟</legend>{result.routes.map((r, i) => <label key={i} className="mt-3 flex items-center gap-3 rounded-xl border border-[#cfe0d4] p-4"><input type="radio" name="live-route" checked={selected === i} onChange={() => setSelected(i)} />路线 {i + 1}：{r.distanceMeters} 米 · {r.durationSeconds} 秒</label>)}</fieldset>}
        {leg && <p className="mt-3 rounded-xl bg-[#edf6f0] p-4">领域交通输入：{leg.duration.kind === "known" ? `${leg.duration.minutes} 分钟（秒数向上取整）` : "unknown（未知，不补零）"}</p>}
        {result && <Evidence value={result.evidence} />}
      </div>
    </>}
  </section>;
}
