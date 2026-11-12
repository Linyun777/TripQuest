"use client";

import {
  BedDouble,
  CalendarDays,
  Check,
  ChevronDown,
  Clock3,
  CloudRain,
  Flag,
  LocateFixed,
  MapPin,
  Navigation,
  Pencil,
  Plane,
  Plus,
  Sparkles,
  Sun,
  TrainFront,
  TriangleAlert,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import { useState, type ReactNode } from "react";
import type { DraftPatch } from "@tripquest/application/conversation";
import { Badge } from "../_ui/badge";
import { Button } from "../_ui/button";
import { Card, CardBody, CardFooter, CardHeader, CardTitle } from "../_ui/card";
import { cn } from "../_ui/cn";
import { MODE_STYLE } from "./plan-card";
import type { CardPlace, CardVisit, OutingCardView, RequirementsCardView, TravelModeView, TravelView } from "./view-models";

const PREFER_LABEL: Record<TravelView["prefer"], string> = { balanced: "均衡", fast: "快一点", cheap: "省钱", less_walking: "少走路" };
const MODES: TravelModeView[] = ["walking", "transit", "taxi", "bicycling", "driving"];

const ROLE_LABEL = { optional: "想去", required: "必去", fixed: "固定" } as const;
const ROLE_TONE = { optional: "neutral", required: "lake", fixed: "sun" } as const;

/** 提交一个补丁，成功返回 null，失败返回可显示错误，卡片本身不自行假定保存成功。 */
export type CardEdit = (patch: DraftPatch) => Promise<string | null>;

const SLOT_LABELS = [
  ["any", "不限时段"], ["morning", "上午"], ["noon", "中午"], ["afternoon", "下午"], ["dusk", "傍晚"], ["evening", "晚上"],
] as const;

/** 兴趣可指定时段和地点数量；只读卡只显示用户已设置的部分。 */
function InterestIntent({
  interest,
  editing,
  onEdit,
}: {
  interest: RequirementsCardView["interests"][number];
  editing: boolean;
  onEdit: (patch: DraftPatch) => Promise<void>;
}) {
  const when = interest.when ?? "any";
  const count = interest.count ?? 1;
  if (!editing) {
    const parts = [
      ...(interest.when ? [SLOT_LABELS.find(([value]) => value === when)![1]] : []),
      ...(count > 1 ? [`${count} 处`] : []),
    ];
    return parts.length ? <span className="text-lake-600/80">· {parts.join(" · ")}</span> : null;
  }
  const selectClass = "rounded bg-transparent text-xs text-lake-600 hover:bg-lake-100 focus-visible:outline-2";
  return (
    <>
      <select
        aria-label={`“${interest.text}”的时段`}
        value={when}
        onChange={(event) => void onEdit({ updateInterests: [{ id: interest.id, when: event.target.value as typeof when }] })}
        className={selectClass}
      >
        {SLOT_LABELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <select
        aria-label={`“${interest.text}”去几处`}
        value={count}
        onChange={(event) => void onEdit({ updateInterests: [{ id: interest.id, count: Number(event.target.value) }] })}
        className={selectClass}
      >
        {[1, 2, 3].map((value) => <option key={value} value={value}>{value} 处</option>)}
      </select>
    </>
  );
}

// V2.10 起一站最长 600 分钟（大景区、爬山）；卡片上也要选得到。
const STAY_OPTIONS = [30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480, 600];

/** “45 分钟”“2 小时”“4.5 小时”。 */
function stayText(minutes: number): string {
  return minutes >= 120 && minutes % 30 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

export function RequirementsCard({
  card,
  onChoosePlace,
  onStart,
  onEdit,
  onUseLocation,
  locating = false,
  starting = false,
  highlightStart = false,
  onAllocate,
  allocating = false,
}: {
  card: RequirementsCardView;
  onChoosePlace?: (target: string, placeId: string) => void;
  onStart?: () => void;
  onEdit?: CardEdit;
  /** 仅本次点击才请求浏览器定位权限。 */
  onUseLocation?: () => void;
  locating?: boolean;
  starting?: boolean;
  highlightStart?: boolean;
  onAllocate?: (move?: { target: string; day: number }) => void;
  allocating?: boolean;
}) {
  const ready = card.missing.length === 0;
  const allocated = !card.outing || (card.outing.dates?.days ?? 0) <= 1 || !!card.outing.allocation;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = async (patch: DraftPatch) => {
    if (!onEdit || busy) return;
    setBusy(true);
    setError(await onEdit(patch));
    setBusy(false);
  };
  const live = editing && !!onEdit;
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <p className="text-xs font-medium text-lake-600">
            {card.mode === "short" ? "需求卡片 · 逐站挑选" : card.mode === "outing" ? "出游卡片" : "需求卡片"}
            {card.city ? ` · ${card.city}` : ""}
          </p>
          <CardTitle className="mt-0.5 text-base">按这些安排规划，可以吗？</CardTitle>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <WeatherBadge weather={card.weather} />
          {onEdit && (
            <Button size="sm" variant={editing ? "secondary" : "ghost"} className="h-8 px-3" onClick={() => setEditing(!editing)}>
              {editing ? <Check /> : <Pencil />}
              {editing ? "完成" : "编辑"}
            </Button>
          )}
        </div>
      </CardHeader>

      <CardBody className={cn("space-y-4 transition-opacity", busy && "opacity-70")}>
        {card.outing ? <OutingFacts outing={card.outing} /> : (
        <div className="grid grid-cols-2 gap-2.5">
          <Fact icon={<CalendarDays />} label="日期">
            {live ? (
              <input
                type="date"
                aria-label="日期"
                defaultValue={card.date ?? ""}
                onChange={(event) => event.target.value && void edit({ date: event.target.value })}
                className={fieldClass}
              />
            ) : card.dateLabel ? (
              <>{card.dateLabel}{card.dateGuessed && <Guessed />}</>
            ) : <Missing />}
          </Fact>
          <Fact icon={<Clock3 />} label="时段">
            {live ? (
              <span className="flex items-center gap-1">
                <TimeField label="出发时间" value={card.window?.startsAt} onCommit={(value) => edit({ startsAt: value })} />
                <span className="text-ink-faint">–</span>
                <TimeField label="结束时间" value={card.window?.endsAt} onCommit={(value) => edit({ endsAt: value })} />
              </span>
            ) : card.window ? (
              <span className="tabular">{card.window.startsAt} – {card.window.endsAt}</span>
            ) : (
              <Missing />
            )}
          </Fact>
        </div>
        )}

        <div className="space-y-2">
          <PlaceRow
            icon={<Navigation />}
            label={card.outing?.startAt ? `出发 · ${card.outing.startAt}` : "出发"}
            place={card.start}
            onChoose={(placeId) => onChoosePlace?.("start", placeId)}
            onUseLocation={onUseLocation}
            locating={locating}
          />
          {card.visits.map((visit) => (
            <VisitRow
              key={visit.key}
              visit={visit}
              editing={live}
              onEdit={edit}
              onChoose={(placeId) => onChoosePlace?.(visit.key, placeId)}
            />
          ))}
          {card.mode === "short" && card.end.status === "missing" ? (
            // 短途默认以最后一站为终点，只有用户要求返程才保留独立终点。
            <div className="flex gap-3">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-sunken text-ink-soft"><Flag className="size-4" /></span>
              <div className="min-w-0">
                <p className="text-xs text-ink-faint">结束</p>
                <p className="mt-0.5 text-[15px]">最后一站结束，不用回来</p>
              </div>
            </div>
          ) : (
            <PlaceRow
              icon={<Flag />}
              label={card.outing?.endAt ? `结束 · ${card.outing.endAt} 前` : "结束"}
              place={card.outing && card.end.status === "missing" ? card.start : card.end}
              onChoose={(placeId) => onChoosePlace?.("end", placeId)}
              // 一次定位可同时解决起终点绑定，只在起点展示入口，避免重复权限请求。
              onUseLocation={card.start.status === "current" ? undefined : onUseLocation}
              locating={locating}
            />
          )}
        </div>

        {card.outing && (
          <OutingStays
            outing={card.outing}
            onChoose={(target, placeId) => onChoosePlace?.(target, placeId)}
            onConfirm={onEdit ? (id) => void edit({ confirmOvernight: [id] }) : undefined}
            onRemoveArea={live ? (area) => void edit({ removeLodgingAreas: [area] }) : undefined}
            onRemoveStay={live ? (nights) => void edit({ removeStays: [...nights] }) : undefined}
          />
        )}

        {card.outing && ready && (
          <OutingAllocation outing={card.outing} onAllocate={onAllocate} allocating={allocating} />
        )}

        {(card.interests.length > 0 || live) && (
          <div>
            <p className="mb-2 text-xs font-medium text-ink-faint">想体验</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {card.interests.map((interest) => (
                <span
                  key={interest.id}
                  className="inline-flex items-center gap-1 rounded-full bg-lake-50 px-3 py-1 text-sm text-lake-700"
                >
                  <Sparkles className="size-3.5" />
                  {interest.text}
                  {interest.day ? <span className="text-xs text-lake-600/80">第 {interest.day} 天</span> : null}
                  {interest.perDay ? <span className="text-xs text-lake-600/80">每天</span> : null}
                  {interest.city ? <span className="text-xs text-lake-600/80">{interest.city}</span> : null}
                  <InterestIntent interest={interest} editing={live} onEdit={edit} />
                  {live && (
                    <button
                      type="button"
                      aria-label={`去掉“${interest.text}”`}
                      onClick={() => void edit({ removeInterests: [interest.id] })}
                      className="-mr-1 grid size-5 place-items-center rounded-full hover:bg-lake-100"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              ))}
              {live && card.interests.length < 5 && (
                <AddInterest onAdd={(text) => edit({ addInterests: [text] })} />
              )}
            </div>
          </div>
        )}

        <TravelRow travel={card.travel} editing={live} onEdit={edit} />

        {live ? (
          <div className="space-y-2.5 text-sm">
            {card.mode !== "outing" && (
              <div className="flex items-center gap-2">
                <span className="text-ink-soft">方式</span>
                <Segmented
                  value={card.mode}
                  options={[["day", "一日规划"], ["short", "逐站挑选"]]}
                  onChange={(mode) => edit({ mode })}
                />
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-ink-soft">节奏</span>
              <Segmented
                value={card.pace}
                options={[["relaxed", "松一点"], ["standard", "标准"]]}
                onChange={(pace) => edit({ pace })}
              />
            </div>
            <input
              aria-label="其他要求"
              defaultValue={card.notes ?? ""}
              maxLength={200}
              placeholder="其他要求，比如少走路、避开人多"
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value !== (card.notes ?? "")) void edit({ notes: value || null });
              }}
              className={cn(fieldClass, "w-full")}
            />
            <p className="text-xs text-ink-faint">要换地点或加新地方，直接在下面跟我说。</p>
          </div>
        ) : (
          <p className="text-sm text-ink-soft">
            节奏：{card.pace === "relaxed" ? "松一点" : "标准"}
            {card.notes ? ` · ${card.notes}` : ""}
          </p>
        )}

        {error && (
          <p role="alert" className="rounded-(--radius-field) bg-danger-50 px-3.5 py-2 text-sm text-danger-600">
            {error}
          </p>
        )}

        {card.missing.length > 0 && (
          <div className="flex gap-2 rounded-(--radius-field) bg-sun-50 px-3.5 py-2.5 text-sm text-sun-700">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>还需要：{card.missing.join("、")}</span>
          </div>
        )}
      </CardBody>

      <CardFooter className="justify-between">
        <span className="text-xs text-ink-faint">可以直接改卡片，也可以继续跟我说</span>
        <motion.div
          animate={highlightStart && ready ? { scale: [1, 1.06, 1] } : { scale: 1 }}
          transition={{ duration: 0.6, repeat: highlightStart && ready ? 2 : 0 }}
        >
          {/* V2.11：多天的出游先分到各天，再按天生成；底部按钮总是下一步（没分时就是“分到各天”）。 */}
          {card.mode === "outing" && !allocated ? (
            <Button size="sm" disabled={!ready || allocating || !onAllocate} onClick={() => onAllocate?.()}>
              <CalendarDays />
              {allocating ? "分配中…" : "分到各天"}
            </Button>
          ) : (
            <Button size="sm" disabled={!ready || starting || !onStart} onClick={onStart}>
              <Sparkles />
              {starting ? "规划中…" : card.mode === "outing" ? "按天生成" : card.mode === "short" ? "开始挑地方" : "开始规划"}
            </Button>
          )}
        </motion.div>
      </CardFooter>
    </Card>
  );
}

function Fact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="rounded-(--radius-field) bg-sunken/70 px-3.5 py-2.5">
      <p className="flex items-center gap-1.5 text-xs text-ink-faint [&_svg]:size-3.5">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-[15px] font-medium text-ink">{children}</p>
    </div>
  );
}

function Missing() {
  return <span className="text-ink-faint">待补充</span>;
}

/** V4.4：日期是系统定的（用户没说哪天）。 */
function Guessed() {
  return <span className="text-ink-faint"> · 暂定（可改）</span>;
}

const TRANSPORT_WORD = { train: "高铁", flight: "航班", other: "交通" } as const;

/** V2.11 出游：日期范围和每天出门、回住处的时间。 */
function OutingFacts({ outing }: { outing: OutingCardView }) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <Fact icon={<CalendarDays />} label="日期">
        {outing.dates ? <>{outing.dates.label}{outing.dates.guessed && <Guessed />}</> : <Missing />}
      </Fact>
      <Fact icon={<Clock3 />} label="每天">
        <span className="tabular">{outing.dailyWindow.startsAt} – {outing.dailyWindow.endsAt}</span>
      </Fact>
    </div>
  );
}

/**
 * V2.11 出游：每晚住哪、用户给的固定交通。车次没填时说明按中午到达估计；过夜交通要用户在这里确认，
 * 没确认之前卡片挡住开始规划（缺项里有）。
 */
function OutingStays({
  outing,
  onChoose,
  onConfirm,
  onRemoveArea,
  onRemoveStay,
}: {
  outing: OutingCardView;
  onChoose: (target: string, placeId: string) => void;
  onConfirm?: (id: string) => void;
  onRemoveArea?: (area: string) => void;
  onRemoveStay?: (nights: readonly number[]) => void;
}) {
  const hints = outing.rideHints ?? [];
  const stays = outing.stays ?? [];
  if (!outing.lodging.length && !outing.transports.length && !hints.length) return null;
  const areas = outing.lodgingAreas ?? [];
  const name = (place: OutingCardView["transports"][number]["from"]) => (place.status === "bound" ? place.name : "车站待定");
  return (
    <div className="space-y-2">
      {outing.transports.map((item) => (
        <div key={item.id} className="flex gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-sunken text-ink-soft [&_svg]:size-4">
            {item.mode === "flight" ? <Plane /> : <TrainFront />}
          </span>
          <div className="min-w-0 flex-1 text-[15px]">
            <p className="text-xs text-ink-faint">
              第 {item.day} 天 · {TRANSPORT_WORD[item.mode]}{item.suggested?.day ? " · 日子按住宿暂定（可改）" : item.suggested ? " · 暂定（可改）" : ""}
            </p>
            <p className="mt-0.5">
              {name(item.from)} <span className="tabular">{item.departAt ?? ""}</span>
              <span className="text-ink-faint"> → </span>
              {name(item.to)} <span className="tabular">{item.arriveAt ? `${item.overnight ? "次日 " : ""}${item.arriveAt}` : ""}</span>
            </p>
            {(!item.departAt || !item.arriveAt) && (
              <p className="text-xs text-ink-faint">
                {item.overnight && !item.departAt && !item.arriveAt
                  ? "未填车次，按晚上 21:00 出发、次日 07:00 到达估计"
                  : "未填车次，按两站的距离估计车程，建议填上车次"}
              </p>
            )}
            {item.from.status === "choose" && <PlaceValue place={item.from} onChoose={(placeId) => onChoose(`${item.id}:from`, placeId)} />}
            {item.to.status === "choose" && <PlaceValue place={item.to} onChoose={(placeId) => onChoose(`${item.id}:to`, placeId)} />}
            {(["from", "to"] as const).map((end) => {
              const others = item.suggested?.[end] ?? [];
              return others.length > 0 && (
                <SwapStation key={end} label={end === "from" ? "出发站" : "到达站"} choices={others} onChoose={(placeId) => onChoose(`${item.id}:${end}`, placeId)} />
              );
            })}
            {item.overnight && (
              item.confirmed ? (
                <p className="mt-1 text-xs text-lake-600">已确认第 {item.day} 晚在{item.mode === "flight" ? "飞机" : "车"}上过夜</p>
              ) : (
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-sun-700">
                  <span>第 {item.day} 晚在{item.mode === "flight" ? "飞机" : "车"}上过夜，不安排住处</span>
                  {onConfirm && (
                    <Button size="sm" variant="secondary" className="h-7 px-2.5" onClick={() => onConfirm(item.id)}>
                      <Check />
                      确认
                    </Button>
                  )}
                </div>
              )
            )}
          </div>
        </div>
      ))}
      {hints.map((hint) => (
        <p key={hint} className="pl-11 text-xs text-sun-700">{hint}</p>
      ))}
      {stays.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pl-11 text-xs text-ink-soft">
          <span>住在哪</span>
          {stays.map((stay) => (
            <span key={stay.text} className="inline-flex items-center gap-1 rounded-full bg-sunken px-2.5 py-0.5">
              {stay.text}
              {onRemoveStay && (
                <button
                  type="button"
                  aria-label={`去掉“${stay.text}”`}
                  onClick={() => onRemoveStay(stay.nights)}
                  className="-mr-1 grid size-4 place-items-center rounded-full hover:bg-line"
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {outing.lodging.map((night) => (
        <div key={night.night} className="flex gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-sunken text-ink-soft [&_svg]:size-4">
            <BedDouble />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-ink-faint">
              第 {night.night} 晚{night.suggested ? " · 暂定（系统推荐，可换）" : ""}
            </p>
            {night.onBoard ? (
              <p className="mt-0.5 text-[15px]">在车上</p>
            ) : night.place.status === "missing" ? (
              <p className="mt-0.5 text-[15px] text-ink-faint">
                住处未定{areas.length ? `，规划时在${areas.join("、")}附近找` : "，规划时帮你暂定一家"}
              </p>
            ) : (
              <PlaceValue place={night.place} onChoose={(placeId) => onChoose(`n${night.night}`, placeId)} />
            )}
            {night.others && night.others.length > 0 && (
              <SwapStation label="住处" choices={night.others} onChoose={(placeId) => onChoose(`n${night.night}`, placeId)} />
            )}
          </div>
        </div>
      ))}
      {areas.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pl-11 text-xs text-ink-soft">
          <span>住处区域</span>
          {areas.map((area) => (
            <span key={area} className="inline-flex items-center gap-1 rounded-full bg-sunken px-2.5 py-0.5">
              {area}附近
              {onRemoveArea && (
                <button
                  type="button"
                  aria-label={`去掉住处区域“${area}”`}
                  onClick={() => onRemoveArea(area)}
                  className="-mr-1 grid size-4 place-items-center rounded-full hover:bg-line"
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * V2.11 出游：分到各天的预览。每天去哪、一句理由；每一项可以移到别的天（会固定在那天，并重新检查），
 * 检查发现的问题显示在下面。
 */
function OutingAllocation({
  outing,
  onAllocate,
  allocating,
}: {
  outing: OutingCardView;
  onAllocate?: (move?: { target: string; day: number }) => void;
  allocating: boolean;
}) {
  const allocation = outing.allocation;
  const days = outing.dates?.days ?? 0;
  return (
    <div className="space-y-2 rounded-(--radius-field) bg-sunken/70 px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-ink-faint">分到各天</p>
        {onAllocate && (
          <Button size="sm" variant="secondary" className="h-7 px-2.5" disabled={allocating} onClick={() => onAllocate()}>
            <CalendarDays />
            {allocating ? "分配中…" : allocation ? "重新分" : "分到各天"}
          </Button>
        )}
      </div>
      {allocation ? (
        <div className="space-y-2.5">
          {allocation.days.map((entry) => (
            <div key={entry.day}>
              <p className="text-xs text-ink-soft">{entry.label}{entry.reason ? ` · ${entry.reason}` : ""}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {entry.items.length ? entry.items.map((item) => (
                  <span key={item.target} className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-sm">
                    {item.kind === "visit" ? <MapPin className="size-3.5 text-lake-600" /> : <Sparkles className="size-3.5 text-lake-600" />}
                    {item.name}
                    {onAllocate && days > 1 && (
                      <select
                        aria-label={`把“${item.name}”移到哪一天`}
                        value={entry.day}
                        disabled={allocating}
                        onChange={(event) => onAllocate({ target: item.target, day: Number(event.target.value) })}
                        className="ml-0.5 rounded bg-transparent text-xs text-ink-faint"
                      >
                        {Array.from({ length: days }, (_, index) => (
                          <option key={index + 1} value={index + 1}>第 {index + 1} 天</option>
                        ))}
                      </select>
                    )}
                  </span>
                )) : <span className="text-sm text-ink-faint">这天空着</span>}
              </div>
            </div>
          ))}
          {allocation.problems.length > 0 && (
            <p className="text-xs text-sun-700">要注意：{allocation.problems.join("；")}</p>
          )}
        </div>
      ) : (
        <p className="text-sm text-ink-soft">按住处和车站远近、每天的空闲把地点分到各天，分好后可以再挪。</p>
      )}
    </div>
  );
}

function PlaceRow({
  icon,
  label,
  place,
  onChoose,
  onUseLocation,
  locating = false,
}: {
  icon: ReactNode;
  label: string;
  place: CardPlace;
  onChoose: (placeId: string) => void;
  onUseLocation?: () => void;
  locating?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-sunken text-ink-soft [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-ink-faint">{label}</p>
        <PlaceValue place={place} onChoose={onChoose} onUseLocation={onUseLocation} locating={locating} />
      </div>
    </div>
  );
}

function VisitRow({
  visit,
  editing,
  onEdit,
  onChoose,
}: {
  visit: CardVisit;
  editing: boolean;
  onEdit: (patch: DraftPatch) => Promise<void>;
  onChoose: (placeId: string) => void;
}) {
  const detail = visit.role === "fixed" && visit.startsAt
    ? `${visit.startsAt}–${visit.endsAt}`
    : visit.stayMinutes ? `约 ${stayText(visit.stayMinutes)}${visit.estimated ? "（估计）" : ""}` : null;
  const when = [visit.day ? `第 ${visit.day} 天` : null, detail].filter(Boolean).join(" · ") || null;
  const update = (change: Omit<NonNullable<DraftPatch["updateVisits"]>[number], "key">) =>
    onEdit({ updateVisits: [{ key: visit.key, ...change }] });
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-lake-50 text-lake-600 [&_svg]:size-4">
        <MapPin />
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Segmented
              value={visit.role}
              options={[["optional", "想去"], ["required", "必去"], ["fixed", "固定"]]}
              onChange={(role) => update({ role })}
            />
            {visit.role === "fixed" ? (
              <span className="flex items-center gap-1">
                <TimeField label="开始" value={visit.startsAt} onCommit={(value) => update({ startsAt: value })} />
                <span className="text-ink-faint">–</span>
                <TimeField label="结束" value={visit.endsAt} onCommit={(value) => update({ endsAt: value })} />
              </span>
            ) : (
              <select
                aria-label="停留时长"
                value={visit.stayMinutes ?? ""}
                onChange={(event) => update({ stayMinutes: event.target.value ? Number(event.target.value) : null })}
                className={cn(fieldClass, "h-8 py-0")}
              >
                <option value="">停留时长自动</option>
                {[...new Set([...STAY_OPTIONS, ...(visit.stayMinutes ? [visit.stayMinutes] : [])])].sort((a, b) => a - b).map((minutes) => (
                  <option key={minutes} value={minutes}>
                    停留 {stayText(minutes)}{minutes === visit.stayMinutes && visit.estimated ? "（估计）" : ""}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => void onEdit({ removeVisits: [visit.key] })}
              className="ml-auto rounded-full px-2 py-1 text-ink-faint hover:bg-danger-50 hover:text-danger-600"
            >
              移除
            </button>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-xs text-ink-faint">
            <Badge tone={ROLE_TONE[visit.role]}>{ROLE_LABEL[visit.role]}</Badge>
            {when && <span className="tabular">{when}</span>}
          </p>
        )}
        <PlaceValue place={visit.place} onChoose={onChoose} />
      </div>
    </div>
  );
}

const fieldClass = cn(
  "h-8 rounded-lg border border-line bg-surface px-2 text-sm text-ink",
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lake-600",
);

/** 输入完整 HH:mm 后才提交；浏览器时间输入会发出部分值，不能每次输入都当成合法修改。 */
function TimeField({ label, value, onCommit }: { label: string; value?: string; onCommit: (value: string) => void }) {
  return (
    <input
      type="time"
      aria-label={label}
      defaultValue={value ?? ""}
      onBlur={(event) => {
        const next = event.target.value;
        if (/^\d{2}:\d{2}$/.test(next) && next !== value) onCommit(next);
      }}
      className={cn(fieldClass, "tabular w-[5.5rem]")}
    />
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  return (
    <span className="inline-flex rounded-full bg-sunken p-0.5">
      {options.map(([option, label]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => option !== value && onChange(option)}
          className={cn(
            "h-7 rounded-full px-2.5 text-xs font-medium transition-colors",
            value === option ? "bg-surface text-ink shadow-card" : "text-ink-soft hover:text-ink",
          )}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

function AddInterest({ onAdd }: { onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  const add = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onAdd(trimmed.slice(0, 40));
    setText("");
  };
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-2 py-0.5">
      <Plus className="size-3.5 text-ink-faint" />
      <input
        aria-label="添加想体验的"
        value={text}
        maxLength={40}
        placeholder="添加"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            add();
          }
        }}
        onBlur={add}
        className="w-24 bg-transparent text-sm outline-none placeholder:text-ink-faint"
      />
    </span>
  );
}

/** 历史需求卡收起为一行，可展开查看当时状态，不恢复编辑能力。 */
export function SupersededCard({ card }: { card: RequirementsCardView }) {
  const [open, setOpen] = useState(false);
  const summary = [card.dateLabel, card.window && `${card.window.startsAt}–${card.window.endsAt}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="rounded-(--radius-field) border border-line bg-surface/60">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm text-ink-soft"
      >
        <span className="font-medium text-ink">需求卡片（已更新）</span>
        <span className="truncate">{summary}</span>
        <ChevronDown className={cn("ml-auto size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-line px-1 pb-1">
          <RequirementsCard card={card} />
        </div>
      )}
    </div>
  );
}

function PlaceValue({
  place,
  onChoose,
  onUseLocation,
  locating = false,
}: {
  place: CardPlace;
  onChoose: (placeId: string) => void;
  onUseLocation?: () => void;
  locating?: boolean;
}) {
  if (place.status === "bound") {
    return (
      <p className="mt-0.5 truncate text-[15px] font-medium">
        {place.nearby && <span className="font-normal text-ink-soft">当前位置附近 · </span>}
        {place.name}
      </p>
    );
  }
  if (place.status === "missing") return <p className="mt-0.5 text-[15px]"><Missing /></p>;
  if (place.status === "current") {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-medium">当前位置</span>
        {onUseLocation && (
          <Button size="sm" variant="secondary" className="h-8 px-3" disabled={locating} onClick={onUseLocation}>
            <LocateFixed />
            {locating ? "定位中…" : "用我的位置"}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="mt-1">
      <p className="text-sm text-ink-soft">“{place.mention}”指的是哪里？</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {place.choices.map((choice) => (
          <button
            key={choice.placeId}
            type="button"
            onClick={() => onChoose(choice.placeId)}
            className={cn(
              "rounded-full border border-line bg-surface px-3 py-1.5 text-left text-sm transition-colors",
              "hover:border-lake-500 hover:bg-lake-50",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600",
            )}
          >
            {choice.name}
            {choice.hint && <span className="ml-1 text-xs text-ink-faint">{choice.hint}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** V3.6：暂定车站、住处的“换一个”：点一个就换成它（同等用户选时的选择，目标 t1:to、n1）。 */
function SwapStation({ label, choices, onChoose }: { label: string; choices: readonly { placeId: string; name: string }[]; onChoose: (placeId: string) => void }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
      <span>{label}换一个</span>
      {choices.map((choice) => (
        <button
          key={choice.placeId}
          type="button"
          onClick={() => onChoose(choice.placeId)}
          className={cn(
            "rounded-full border border-line bg-surface px-2.5 py-1 transition-colors",
            "hover:border-lake-500 hover:bg-lake-50",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600",
          )}
        >
          {choice.name}
        </button>
      ))}
    </div>
  );
}

export function WeatherBadge({ weather }: { weather: RequirementsCardView["weather"] }) {
  if (weather === null) return null;
  if (weather === "unavailable") return <Badge>暂无天气预报</Badge>;
  return (
    <Badge tone={weather.wet ? "rain" : "sun"} className="shrink-0">
      {weather.wet ? <CloudRain /> : <Sun />}
      <span>{weather.dayWeather}</span>
      <span className="tabular">{Math.round(weather.lowCelsius)}–{Math.round(weather.highCelsius)}°</span>
    </Badge>
  );
}

/** 交通初始为推荐值，用户修改后明确记录可用方式和偏好；不能把推荐误记为用户已选。 */
function TravelRow({ travel, editing, onEdit }: { travel: TravelView; editing: boolean; onEdit: (patch: DraftPatch) => Promise<void> }) {
  const set = (allowed: readonly TravelModeView[], prefer: TravelView["prefer"]) =>
    onEdit({ travel: { allowed: [...allowed], prefer } });
  if (!editing) {
    return (
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-ink-soft">
        <span>出行：</span>
        {travel.allowed.map((mode) => {
          const style = MODE_STYLE[mode];
          const Icon = style.icon;
          return (
            <span key={mode} className={cn("inline-flex items-center gap-0.5", style.className)}>
              <Icon className="size-3.5" />
              {style.label}
            </span>
          );
        })}
        <span>· {PREFER_LABEL[travel.prefer]}</span>
        {travel.recommended && <Badge tone="lake">推荐</Badge>}
      </p>
    );
  }
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-ink-soft">出行</span>
        {MODES.map((mode) => {
          const on = travel.allowed.includes(mode);
          const style = MODE_STYLE[mode];
          const Icon = style.icon;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={on}
              // 至少保留一种可用交通方式，避免提交没有任何可选方式的需求。
              onClick={() => {
                const next = on ? travel.allowed.filter((item) => item !== mode) : [...travel.allowed, mode];
                if (next.length) void set(next, travel.prefer);
              }}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors",
                on ? "border-lake-500 bg-lake-50 text-lake-700" : "border-line text-ink-faint hover:text-ink",
              )}
            >
              <Icon className="size-3.5" />
              {style.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-ink-soft">偏好</span>
        <Segmented
          value={travel.prefer}
          options={[["balanced", "均衡"], ["fast", "快一点"], ["cheap", "省钱"], ["less_walking", "少走路"]]}
          onChange={(prefer) => void set(travel.allowed, prefer)}
        />
      </div>
    </div>
  );
}
