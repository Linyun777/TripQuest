"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, MapPin, Search } from "lucide-react";
import { Button } from "../_ui/button";
import { mountPlanningMap, updateMapOverlays, type AmapApi, type AmapInstance, type MapClickEvent } from "../journeys/amap-loader";
import { openBoundaryMap, pickBoundaryAtPoint, searchBoundaryPlaces } from "./boundary-search";

type Area = Extract<Awaited<ReturnType<typeof openBoundaryMap>>, { city: object }>;
type Choices = Extract<Awaited<ReturnType<typeof searchBoundaryPlaces>>, { items: unknown }>;
export type BoundaryChoice = Choices["items"][number];
const empty: BoundaryChoice[] = [];

function PickerMap({ area, items, selected, onPick, onSelect }: {
  area: Area; items: readonly BoundaryChoice[]; selected: string;
  onPick: (longitude: number, latitude: number) => void;
  onSelect: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState<{ api: AmapApi; map: AmapInstance } | null>(null);
  const [failed, setFailed] = useState(false);
  const select = useRef(onSelect);
  const pick = useRef(onPick);
  useEffect(() => { select.current = onSelect; pick.current = onPick; }, [onSelect, onPick]);
  const { center } = area.city;
  const { config } = area;
  useEffect(() => {
    if (!host.current || !center || config.mode !== "amap") return;
    return mountPlanningMap({
      container: host.current, key: config.key, serviceHost: config.serviceHost,
      center: [center.longitude, center.latitude],
      onReady(api, map) { setMounted({ api, map }); }, onError() { setFailed(true); },
    });
  }, [center, config]);
  useEffect(() => {
    if (!mounted) return;
    const click = (event: MapClickEvent) => pick.current(event.lnglat.getLng(), event.lnglat.getLat());
    mounted.map.on("click", click);
    return () => mounted.map.off("click", click);
  }, [mounted]);
  useEffect(() => {
    if (!items.length || !mounted) return;
    return updateMapOverlays(mounted.api, mounted.map, items.map((item, i) => ({
      id: item.id, label: String(i + 1), name: item.name, position: [item.longitude, item.latitude],
    })), (id) => select.current(id), [], false);
  }, [mounted, items]);
  useEffect(() => {
    if (!mounted || !selected) return;
    const item = items.find((choice) => choice.id === selected);
    if (item) mounted.map.setCenter([item.longitude, item.latitude]);
  }, [mounted, items, selected]);
  if (failed || !center || config.mode !== "amap") {
    return <p role="status" className="rounded-lg bg-sunken px-3 py-2 text-sm text-ink-soft">底图暂不可用，可搜索并从列表选择地点。</p>;
  }
  return <div className="relative overflow-hidden rounded-xl border border-line bg-sunken">
    <div aria-label={area.city.name + "选点地图"} ref={host} className="h-[clamp(13rem,36dvh,22rem)] w-full" />
    {mounted && !items.length && <p className="pointer-events-none absolute bottom-3 left-3 rounded-full bg-surface/95 px-3 py-1 text-xs">轻点地图选择附近地点</p>}
    {!mounted && <p className="absolute inset-0 grid place-items-center text-sm text-ink-soft">正在加载地图…</p>}
  </div>;
}

export function BoundaryPicker({ initialCity, initialLabel, multipleCities, onConfirm }: {
  initialCity: string; initialLabel: string; multipleCities: boolean; onConfirm: (pick: BoundaryChoice) => void;
}) {
  const [city, setCity] = useState(initialCity);
  const [cityInput, setCityInput] = useState("");
  const [changeCity, setChangeCity] = useState(false);
  const [area, setArea] = useState<Area | null>(null);
  const [areaError, setAreaError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly BoundaryChoice[]>(empty);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState("");
  const version = useRef(0);
  const composing = useRef(false);
  const searched = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const invalidate = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    return ++version.current;
  }, []);
  const opening = useRef<{ city: string; attempt: number; request: ReturnType<typeof openBoundaryMap> } | null>(null);
  useEffect(() => {
    let current = true;
    if (opening.current?.city !== city || opening.current.attempt !== attempt) {
      opening.current = { city, attempt, request: openBoundaryMap(city) };
    }
    opening.current.request.then((result) => {
      if (!current) return;
      if (result.city) setArea(result);
      else setAreaError(result.error);
    }).catch(() => { if (current) setAreaError("城市地图暂时无法加载。"); });
    return () => { current = false; invalidate(); };
  }, [city, attempt, invalidate]);
  const code = area?.city.adcode ?? (/^\d{6}$/.test(city) ? city : "");
  const cityLabel = area?.city.name ?? (/^\d{6}$/.test(city) ? initialLabel : city);
  const chosen = items.find((item) => item.id === selected);
  function clearResults() {
    invalidate();
    searched.current = "";
    setItems(empty);
    setSelected("");
    setStatus("");
  }
  async function lookup(request: () => ReturnType<typeof searchBoundaryPlaces> | ReturnType<typeof pickBoundaryAtPoint>, tapped: boolean) {
    const nonce = invalidate();
    if (tapped) searched.current = "";
    setSelected("");
    setItems(empty);
    setStatus(tapped ? "正在识别这个位置…" : "正在搜索…");
    try {
      const result = await request();
      if (version.current !== nonce) return;
      if (!result.items) { searched.current = ""; setStatus(result.error); return; }
      setItems(result.items);
      if (tapped && result.items.length) setSelected(result.items[0].id);
      setStatus(result.items.length ? "" : "没有搜到地点，试试其他名称。");
    } catch {
      if (version.current === nonce) {
        searched.current = "";
        setStatus("地点查询暂时不可用，请重试。");
      }
    }
  }
  function search(text: string) {
    const keyword = text.trim();
    if (!keyword || !code || composing.current || searched.current === keyword) return;
    searched.current = keyword;
    void lookup(() => searchBoundaryPlaces(keyword, code), false);
  }
  function editQuery(text: string) {
    clearResults(); setQuery(text);
    if (!composing.current && text.trim().length >= 2 && code) timer.current = setTimeout(() => search(text), 550);
  }
  function reload(next: string) {
    clearResults(); setArea(null); setAreaError(""); setQuery(""); setChangeCity(false);
    setCity(next); setAttempt((n) => n + 1);
  }
  return <div className="space-y-3">
    <div className="flex items-center gap-2">
      {multipleCities ? <button type="button" aria-expanded={changeCity} onClick={() => { setCityInput(""); setChangeCity(!changeCity); }}
        className="inline-flex min-h-10 shrink-0 items-center gap-1 text-sm font-semibold">{cityLabel}<ChevronDown className="size-3.5" /></button>
        : <span className="shrink-0 text-sm font-semibold">{cityLabel}</span>}
      <form className="flex min-w-0 flex-1 items-center rounded-full border border-line bg-surface px-3"
        onSubmit={(e) => { e.preventDefault(); search(query); }}>
        <input aria-label="搜索地点" type="search" placeholder="搜酒店、景点或车站" maxLength={80} value={query}
          onCompositionStart={() => { composing.current = true; invalidate(); }}
          onCompositionEnd={(e) => { composing.current = false; editQuery(e.currentTarget.value); }}
          onChange={(e) => editQuery(e.target.value)} className="h-11 min-w-0 flex-1 bg-transparent text-base outline-none" />
        <button type="submit" disabled={!query.trim() || !code} aria-label="搜索" className="p-2 text-ink-soft"><Search className="size-4" /></button>
      </form>
    </div>
    {changeCity && <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (cityInput.trim()) reload(cityInput.trim()); }}>
      <input aria-label="城市名称" value={cityInput} maxLength={20} placeholder="输入城市名" className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2"
        onChange={(e) => setCityInput(e.target.value)} />
      <Button type="submit" size="sm" disabled={!cityInput.trim()}>切换城市</Button>
    </form>}
    {area ? <PickerMap key={area.city.adcode} area={area} items={items} selected={selected} onSelect={setSelected}
      onPick={(lng, lat) => void lookup(() => pickBoundaryAtPoint(lng, lat, code), true)} />
      : areaError ? <p role="status" className="text-sm text-ink-soft">{areaError} <button type="button" className="underline" onClick={() => reload(city)}>重试</button></p>
      : <div className="grid h-52 place-items-center rounded-xl bg-sunken text-sm text-ink-soft">正在打开城市地图…</div>}
    <p role="status" className="text-sm text-ink-soft empty:hidden">{status}</p>
    {items.length > 0 && <ul className="divide-y divide-line">
      {items.map((item, index) => <li key={item.id}><button type="button" aria-pressed={item.id === selected}
        onClick={() => setSelected(item.id)} className="flex w-full items-center gap-3 py-3 text-left">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-lake-600 text-xs text-white">{index + 1}</span>
        <span className="min-w-0 flex-1"><strong className="block text-sm">{item.name}</strong>
          {item.address && <span className="block text-xs text-ink-soft">{item.address}</span>}</span>
        {item.id === selected && <Check className="size-4 text-lake-600" />}
      </button></li>)}
    </ul>}
    {chosen && <div className="sticky bottom-0 flex items-center gap-2 border-t border-line bg-surface py-3">
      <MapPin className="size-4 shrink-0 text-lake-600" /><span className="flex-1 truncate text-sm font-semibold">{chosen.name}</span>
      <Button onClick={() => onConfirm(chosen)}>用这个地点</Button>
    </div>}
  </div>;
}
