"use client";

import { useState } from "react";
import type { DraftPatch } from "@tripquest/application/conversation";
import { Sheet } from "../_ui/sheet";
import { Button } from "../_ui/button";
import { BoundaryPicker, type BoundaryChoice } from "./boundary-picker";
import type { CardEdit } from "./requirements-card";
import type { CardPlace, OutingCardView, RequirementsCardView } from "./view-models";

type Field = { name: string; pick?: BoundaryChoice };
type End = "last" | "prefer" | "must";
type Ride = OutingCardView["transports"][number];
const input = "w-full rounded-lg border border-line bg-surface px-2 py-2 text-sm";
const group = "grid grid-cols-2 gap-2";
const nameOf = (place?: CardPlace) => place?.status === "bound" ? place.name : "";
const cityOf = (place: CardPlace | undefined, fallback: string) => place?.status === "bound" && place.cityCode ? place.cityCode : fallback;
const dateAfter = (date: string, offset: number) =>
  new Date(Date.parse(date + "T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10);

function PlaceField({ label, value, city, cityLabel, multipleCities, onChange }: {
  label: string; value: Field; city: string; cityLabel: string; multipleCities: boolean; onChange: (item: Field) => void;
}) {
  const [open, setOpen] = useState(false);
  return <div>
    <button type="button" className={input} onClick={() => setOpen(true)}>{label} · {value.name || "地图选点"}</button>
    <Sheet open={open} onOpenChange={setOpen} title={label} desktopSide>
      {open && <BoundaryPicker initialCity={value.pick?.cityCode ?? city} initialLabel={/^\d{6}$/.test(cityLabel) ? "选择城市" : cityLabel} multipleCities={multipleCities} onConfirm={(pick) => {
        onChange({ name: pick.name, pick }); setOpen(false);
      }} />}
    </Sheet>
  </div>;
}

function DateEditor({ card, date, onEdit }: { card: RequirementsCardView; date: string; onEdit: CardEdit }) {
  const outing = card.outing;
  const override = outing?.dayBoundaries?.[date];
  const first = date === outing?.dates?.from;
  const last = date === outing?.dates?.to;
  const day = date && outing?.dates ? Math.round((Date.parse(date) - Date.parse(outing.dates.from)) / 86400000) : 0;
  const previousRide = outing?.transports.find((ride) => ride.day === day && ride.overnight);
  const startName = nameOf(override?.start) || (day > 0 ? nameOf(previousRide?.to) || nameOf(outing?.lodging[day - 1]?.place) : nameOf(card.start));
  const endName = nameOf(override?.end) || (!date || last ? nameOf(card.end) : "");
  const [start, setStart] = useState<Field>({ name: startName });
  const [end, setEnd] = useState<Field>({ name: endName });
  const [policy, setPolicy] = useState<End>(override?.endPolicy ?? (endName ? card.endPolicy === "prefer" ? "prefer" : "must" : "last"));
  const from = override?.startsAt ?? (first ? outing?.startAt : null) ?? outing?.dailyWindow.startsAt ?? card.startsAt ?? card.window?.startsAt ?? "";
  const to = override?.endsAt ?? (last ? outing?.endAt : null) ?? outing?.dailyWindow.endsAt ?? card.endsAt ?? card.window?.endsAt ?? "";
  const [startsAt, setStarts] = useState(from);
  const [endsAt, setEnds] = useState(to);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const common = { cityLabel: card.city, city: card.cityCode ?? card.city, multipleCities: !!outing };
  async function save(reset = false) {
    if (busy) return;
    if (!reset && ((!!outing && (!startsAt || !endsAt)) || (startsAt && endsAt && startsAt >= endsAt) || (policy !== "last" && !end.name))) {
      setMessage("请检查出发、截止时刻及指定的结束地点。"); return;
    }
    const tokens: string[] = [];
    const ref = (field: Field) => ({ candidate: "c" + tokens.push(field.pick!.token) });
    const places = { ...(start.pick ? { start: ref(start) } : {}), ...(end.pick && policy !== "last" ? { end: ref(end) } : {}) };
    let patch: DraftPatch;
    if (date) {
      patch = { dayBoundary: reset ? { date, reset: true } : {
        date, ...places, ...(startsAt !== from ? { startsAt } : {}), ...(endsAt !== to ? { endsAt } : {}),
        ...(policy !== (override?.endPolicy ?? (endName ? card.endPolicy ?? "must" : "last")) || places.end ? { endPolicy: policy } : {}),
      } };
    } else if (outing) {
      patch = { ...places, endPolicy: policy, dailyWindow: { startsAt, endsAt } };
    } else patch = { ...places, endPolicy: policy, ...(startsAt ? { startsAt } : {}), ...(endsAt ? { endsAt } : {}) };
    setBusy(true);
    try { setMessage((await onEdit(patch, tokens)) ?? "已保存"); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3 pt-2">
    <PlaceField label="出发地点" value={start} onChange={setStart} {...common} city={cityOf(override?.start?.status === "bound" ? override.start : day > 0 ? previousRide?.to ?? outing?.lodging[day - 1]?.place : card.start, common.city)} />
    <label>结束方式<select className={input} value={policy} onChange={(e) => setPolicy(e.target.value as End)}>
      <option value="last">在最后一站结束</option><option value="prefer">尽量到达指定地点</option><option value="must">必须按时到达</option>
    </select></label>
    {policy !== "last" && <PlaceField label="结束地点" value={end} onChange={setEnd} {...common} city={cityOf(override?.end?.status === "bound" ? override.end : card.end, common.city)} />}
    <div className={group}>
      <label>出发时间<input className={input} type="time" value={startsAt} onChange={(e) => setStarts(e.target.value)} /></label>
      <label>最晚到达<input className={input} type="time" disabled={endsAt === "24:00"} value={endsAt === "24:00" ? "" : endsAt} onChange={(e) => setEnds(e.target.value)} /></label>
    </div>
    <label className="flex gap-2"><input type="checkbox" checked={endsAt === "24:00"} onChange={(e) => setEnds(e.target.checked ? "24:00" : to === "24:00" ? "" : to)} />当天午夜 24:00</label>
    <Button size="sm" disabled={busy} onClick={() => void save()}>保存设置</Button>
    {override && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(true)}>恢复继承</Button>}
    <p role="status">{message}</p>
  </div>;
}

function RideEditor({ card, ride, onEdit }: { card: RequirementsCardView; ride?: Ride; onEdit: CardEdit }) {
  const range = card.outing!.dates!;
  const [mode, setMode] = useState<Ride["mode"]>(ride?.mode ?? "train");
  const [from, setFrom] = useState<Field>({ name: nameOf(ride?.from) });
  const [to, setTo] = useState<Field>({ name: nameOf(ride?.to) });
  const [date, setDate] = useState(dateAfter(range.from, (ride?.day ?? 1) - 1));
  const [depart, setDepart] = useState(ride?.departAt ?? "");
  const [arrive, setArrive] = useState(ride?.arriveAt ?? "");
  const [next, setNext] = useState(ride?.overnight ?? false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const fields = { cityLabel: card.city, city: card.cityCode ?? card.city, multipleCities: true };
  async function save() {
    if (!from.name || !to.name || !date || date < range.from || date > range.to || (!next && depart && arrive && arrive <= depart)) {
      setMessage("请核对两端车站、日期和时刻。如果隔天到站，请选次日。"); return;
    }
    const tokens: string[] = [];
    const values = { mode, date, departAt: depart || null, arriveAt: arrive || null, arriveDay: next ? "next" as const : "same" as const,
      ...(from.pick ? { from: { candidate: "c" + tokens.push(from.pick.token) } } : {}),
      ...(to.pick ? { to: { candidate: "c" + tokens.push(to.pick.token) } } : {}) };
    setBusy(true);
    try {
      setMessage(await onEdit(ride ? { updateTransports: [{ ...values, id: ride.id }], ...(next ? { confirmOvernight: [ride.id] } : {}) }
        : { addTransports: [values] }, tokens) ?? "已保存车次");
    } finally { setBusy(false); }
  }
  return <div className="space-y-2 py-2">
    <select aria-label="交通方式" className={input} value={mode} onChange={(e) => setMode(e.target.value as Ride["mode"])}>
      <option value="train">火车／高铁</option><option value="flight">航班</option><option value="other">其他交通</option>
    </select>
    <PlaceField label="出发站" {...fields} city={cityOf(ride?.from, fields.city)} value={from} onChange={setFrom} />
    <PlaceField label="到达站" {...fields} city={cityOf(ride?.to, fields.city)} value={to} onChange={setTo} />
    <label>发车日期<input type="date" className={input} min={range.from} max={range.to} value={date} onChange={(e) => setDate(e.target.value)} /></label>
    <div className={group}>
      <label>发车时间<input type="time" className={input} value={depart} onChange={(e) => setDepart(e.target.value)} /></label>
      <label>到达时间<input type="time" className={input} value={arrive} onChange={(e) => setArrive(e.target.value)} /></label>
    </div>
    <label>到达日期<select className={input} value={Number(next)} onChange={(e) => setNext(e.target.value === "1")}>
      <option value="0">当天 {date}</option><option value="1">次日 {date && dateAfter(date, 1)}</option>
    </select></label>
    <Button size="sm" disabled={busy} onClick={() => void save()}>{next ? "保存这趟夜车" : "保存车次"}</Button>
    <p role="status">{message}</p>
  </div>;
}

export function BoundaryControls({ card, onEdit }: { card: RequirementsCardView; onEdit: CardEdit }) {
  const [section, setSection] = useState("");
  const outing = card.outing;
  const dates = outing?.dates;
  return <div className="space-y-2">
    <button type="button" className={input} onClick={() => setSection("bounds")}>选择起终点和时间</button>
    {dates && <button type="button" className={input} onClick={() => setSection("rides")}>填写车站和车次时间</button>}
    <Sheet open={!!section} onOpenChange={(open) => { if (!open) setSection(""); }} title={section === "rides" ? "固定交通" : "起终点和时间"} desktopSide>
      {section === "bounds" && <div className="space-y-3">
        {outing && <h3>全程起终点与每日默认时段</h3>}
        <DateEditor key={card.fingerprint} card={card} date="" onEdit={onEdit} />
        {dates && Array.from({ length: dates.days }, (_, i) => dateAfter(dates.from, i)).map((date, i) =>
          <details key={date}><summary>第 {i + 1} 天 · {date} · 只改这一天</summary>
            <DateEditor key={card.fingerprint} card={card} date={date} onEdit={onEdit} /></details>)}
      </div>}
      {section === "rides" && dates && <div className="space-y-3">
        {outing.transports.map((ride) => <details key={ride.id}><summary>第 {ride.day} 天 · {nameOf(ride.from)} → {nameOf(ride.to)}</summary>
          <RideEditor key={card.fingerprint} card={card} ride={ride} onEdit={onEdit} /></details>)}
        <details><summary>新增一趟交通</summary><RideEditor key={card.fingerprint} card={card} onEdit={onEdit} /></details>
      </div>}
    </Sheet>
  </div>;
}
