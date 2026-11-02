"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { dayTime } from "@tripquest/domain";
import type { JourneyDetails } from "@tripquest/application";
import type {
  SavedDayView,
  DayEditChange,
  DayEditPreviewReply,
  DayEditConfirmReply,
  DayEditError,
} from "@tripquest/application/saved-day";
import { DraftTimeline } from "../planning/new/day-draft";
import { DayMap } from "./day-map";
import type { PlanningMapConfig } from "./map-config";
import { useWriteCoordinator } from "./write-coordinator";

const ERROR_TEXT: Record<DayEditError, string> = {
  invalid_request: "修改请求无效，请检查输入。",
  invalid_receipt: "修改确认已失效，请重新预览。",
  not_found: "找不到这份行程。",
  source_not_allowed: "仅支持当前演示目录的已保存行程。",
  invalid_change: "这项修改不允许、没有变化，或会重复另一活动的地点。",
  stale: "计划或事实已经变化，请刷新当前版本，再查看修改影响。",
  candidate_changed: "修改结果需要重新核对，请重新预览。",
  expired: "确认已过期，请重新预览。",
  disabled: "请配置保存开关和独立确认密钥后启用修改。",
  acknowledgment_required: "请先知悉候选中尚未核实的信息。",
  intent_conflict: "这次修改已有不同的确认意图，请刷新后重新预览。",
  temporarily_unavailable:
    "尚未拿到保存结果。它可能已经保存，请保留同一确认内容重试。",
};
const control =
  "mt-2 min-h-12 w-full rounded-xl border border-[#cbdacf] bg-white px-3 text-sm";
const button =
  "min-h-12 rounded-xl bg-[#236d55] px-5 text-sm font-medium text-white disabled:opacity-50";

export function DayEditWorkspace({
  journey,
  initial,
  mapConfig,
  enabled,
  choices,
}: {
  journey: JourneyDetails;
  initial: SavedDayView;
  mapConfig: PlanningMapConfig;
  enabled: boolean;
  choices: { externalId: string; name: string; address: string }[];
}) {
  const router = useRouter();
  const { owner, claim, release } = useWriteCoordinator();
  const [selected, setSelected] = useState(
    `activity:${initial.facts.draft.activities[0].activityId}`,
  );
  const [editActivityId, setEditActivityId] = useState(
    initial.facts.draft.activities[0].activityId,
  );
  const [kind, setKind] = useState<DayEditChange["kind"]>("change_stay");
  const [stay, setStay] = useState(
    String(initial.facts.draft.activities[0].stayMinutes),
  );
  const [replacement, setReplacement] = useState(choices[0]?.externalId ?? "");
  const [candidate, setCandidate] = useState<Extract<
    DayEditPreviewReply,
    { status: "ready" }
  > | null>(null);
  const [showCandidate, setShowCandidate] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState<"preview" | "confirm" | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const sequence = useRef(0);
  const pending = useRef(false);
  const request = useRef<AbortController | null>(null);
  // Both versions bind a candidate: a new plan or a new report invalidates it.
  const versionKey = `${journey.version}:${journey.observationVersion}`;
  const sessionVersion = useRef(versionKey);
  const readOnly =
    journey.version !== journey.currentVersion ||
    journey.observationVersion !== 0;
  const draft =
    showCandidate && candidate ? candidate.draft : initial.facts.draft;
  const places =
    showCandidate && candidate ? candidate.places : initial.facts.places;
  const activityId = selected.startsWith("activity:")
    ? selected.slice("activity:".length)
    : "";
  const target = initial.facts.activities.find(
    (item) => item.activity.activityId === editActivityId,
  )?.activity;
  const targetBinding = initial.activityBindings.find(
    (item) => item.draftActivityId === editActivityId,
  );
  const protectedActivity =
    target?.role === "required" || target?.role === "fixed";

  useEffect(() => {
    if (sessionVersion.current === versionKey) return;
    sessionVersion.current = versionKey;
    // A confirmed server version resets the form while the map stays mounted.
    clearCandidate();
    setSelected(`activity:${initial.facts.draft.activities[0].activityId}`);
    setEditActivityId(initial.facts.draft.activities[0].activityId);
    setStay(String(initial.facts.draft.activities[0].stayMinutes));
    setKind("change_stay");
    setUncertain(false);
  }, [versionKey, initial]);

  useEffect(
    () => () => {
      sequence.current += 1;
      request.current?.abort();
    },
    [],
  );

  function clearCandidate() {
    sequence.current += 1;
    request.current?.abort();
    pending.current = false;
    setBusy(null);
    setCandidate(null);
    setShowCandidate(false);
    setAcknowledge(false);
    setMessage("");
  }
  const select = useCallback((id: string) => setSelected(id), []);
  function chooseTarget(id: string) {
    if (busy === "confirm" || uncertain) return;
    clearCandidate();
    setEditActivityId(id);
    setSelected(`activity:${id}`);
    const item = initial.facts.activities.find(
      (record) => record.activity.activityId === id,
    );
    if (item) setStay(String(item.activity.stayMinutes));
  }

  async function preview() {
    if (pending.current || !targetBinding) return;
    clearCandidate();
    if (!claim("edit")) return;
    const serial = ++sequence.current;
    request.current = new AbortController();
    const change: DayEditChange =
      kind === "remove"
        ? { kind, activityId: targetBinding.activityId }
        : kind === "replace"
          ? {
              kind,
              activityId: targetBinding.activityId,
              externalId: replacement,
              stayMinutes: Number(stay),
            }
          : {
              kind,
              activityId: targetBinding.activityId,
              stayMinutes: Number(stay),
            };
    pending.current = true;
    setBusy("preview");
    try {
      const response = await fetch(
        `/api/journeys/${journey.journeyId}/edits/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: request.current.signal,
          body: JSON.stringify({
            basePlanVersion: journey.version,
            baseObservationVersion: journey.observationVersion,
            change,
          }),
        },
      );
      const result: DayEditPreviewReply = await response.json();
      if (serial !== sequence.current) return;
      if (result.status === "ready") {
        setCandidate(result);
        setShowCandidate(true);
      } else if (result.status === "not_feasible") {
        setMessage(
          `这次修改不可行：${result.issues
            .map((issue) =>
              issue.code === "day_fixed_late"
                ? "无法赶上固定事项"
                : issue.code === "day_window_exceeded"
                  ? "无法在结束时间前到达终点"
                  : "衔接或活动约束未满足",
            )
            .join("；")}。原计划未变。`,
        );
      } else setMessage(ERROR_TEXT[result.status]);
    } catch {
      if (serial === sequence.current)
        setMessage("暂时无法试算修改，请稍后重试。原计划未变。");
    } finally {
      if (serial === sequence.current) {
        pending.current = false;
        setBusy(null);
      }
      release("edit");
    }
  }

  async function confirm() {
    if (pending.current || !candidate) return;
    if (!claim("edit")) return;
    const serial = sequence.current;
    pending.current = true;
    setBusy("confirm");
    setMessage("");
    try {
      const response = await fetch(
        `/api/journeys/${journey.journeyId}/edits/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            receipt: candidate.receipt,
            acknowledgeUnknowns: acknowledge,
          }),
        },
      );
      const result: DayEditConfirmReply = await response.json();
      if (serial !== sequence.current) return;
      if (result.status === "saved" || result.status === "already_saved") {
        setUncertain(false);
        release("edit");
        setMessage(
          `修改已保存为 v${result.planVersion}，正在读取真实当前版本。`,
        );
        router.refresh();
      } else {
        if (
          [
            "expired",
            "stale",
            "candidate_changed",
            "invalid_receipt",
            "intent_conflict",
          ].includes(result.status)
        ) {
          setCandidate(null);
          setShowCandidate(false);
          setAcknowledge(false);
        }
        setUncertain(result.status === "temporarily_unavailable");
        // An uncertain save keeps the page claim until the same intent is retried.
        if (result.status !== "temporarily_unavailable") release("edit");
        setMessage(ERROR_TEXT[result.status]);
      }
    } catch {
      if (serial === sequence.current) {
        setUncertain(true);
        setMessage(ERROR_TEXT.temporarily_unavailable);
      }
    } finally {
      if (serial === sequence.current) {
        pending.current = false;
        setBusy(null);
      }
    }
  }

  return (
    <>
      {candidate && (
        <div className="mt-5 flex flex-wrap gap-3" aria-label="当前与候选显示">
          <button
            type="button"
            onClick={() => setShowCandidate(false)}
            aria-pressed={!showCandidate}
            className="min-h-11 rounded-xl border px-4 text-sm"
          >
            当前 v{journey.version}
          </button>
          <button
            type="button"
            onClick={() => setShowCandidate(true)}
            aria-pressed={showCandidate}
            className="min-h-11 rounded-xl border px-4 text-sm"
          >
            修改候选 · 尚未保存
          </button>
        </div>
      )}
      <DayMap
        draft={draft}
        places={places}
        selected={selected}
        onSelect={select}
        config={mapConfig}
      />
      <DraftTimeline
        draft={draft}
        saved={!showCandidate}
        savedVersion={journey.version}
        selectedActivityId={activityId}
        onSelectActivity={(id) => select(`activity:${id}`)}
        recheckedAt={
          journey.dayDetails && "recheckedAt" in journey.dayDetails
            ? journey.dayDetails.recheckedAt
            : undefined
        }
      />
      {!readOnly && (
        <section
          aria-labelledby="edit-title"
          className="mt-6 rounded-3xl border border-[#dce8e0] bg-white p-5"
        >
          <h2 id="edit-title" className="text-lg font-semibold">
            修改一处活动
          </h2>
          {!enabled && <p className="mt-3 text-sm">{ERROR_TEXT.disabled}</p>}
          <fieldset
            disabled={!enabled || busy === "confirm" || uncertain || (owner !== null && owner !== "edit")}
            className="mt-4 space-y-4"
          >
            <label className="block text-sm font-medium">
              选择活动
              <select
                className={control}
                value={editActivityId}
                onChange={(event) => chooseTarget(event.target.value)}
              >
                {!target && <option value="">请选择活动</option>}
                {initial.facts.draft.activities.map((activity, index) => (
                  <option key={activity.activityId} value={activity.activityId}>
                    {index + 1} ·{" "}
                    {
                      initial.facts.places.find(
                        (place) => place.placeId === activity.placeId,
                      )!.selection.place.name
                    }
                    {["required", "fixed"].includes(activity.role)
                      ? "（受保护）"
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            {protectedActivity ? (
              <p className="text-sm text-[#81553e]">
                必去和固定事项受保护，本阶段不能替换、移除或改停留。
              </p>
            ) : (
              target && (
                <>
                  <label className="block text-sm font-medium">
                    操作
                    <select
                      value={kind}
                      className={control}
                      onChange={(event) => {
                        clearCandidate();
                        setKind(event.target.value as DayEditChange["kind"]);
                      }}
                    >
                      <option value="change_stay">修改停留时长</option>
                      <option value="replace">替换演示地点</option>
                      <option value="remove">移除这项活动</option>
                    </select>
                  </label>
                  {kind === "replace" && (
                    <label className="block text-sm font-medium">
                      替换地点
                      <select
                        value={replacement}
                        className={control}
                        onChange={(event) => {
                          clearCandidate();
                          setReplacement(event.target.value);
                        }}
                      >
                        {choices.map((choice) => (
                          <option
                            key={choice.externalId}
                            value={choice.externalId}
                          >
                            {choice.name} · {choice.address}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {kind !== "remove" && (
                    <label className="block text-sm font-medium">
                      停留分钟（15–240）
                      <input
                        type="number"
                        min={15}
                        max={240}
                        step={1}
                        value={stay}
                        className={control}
                        onChange={(event) => {
                          clearCandidate();
                          setStay(event.target.value);
                        }}
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    disabled={busy === "preview"}
                    onClick={() => void preview()}
                    className={button}
                  >
                    {busy === "preview" ? "正在试算…" : "查看修改影响"}
                  </button>
                </>
              )
            )}
          </fieldset>
          {candidate && (
            <div className="mt-6 space-y-4 rounded-2xl bg-[#f1f7f2] p-4">
              <h3 className="font-semibold">
                修改影响 · 确认前当前仍为 v{journey.version}
              </h3>
              {candidate.comparison.activities.map((item) => (
                <p key={item.activityId} className="text-sm leading-6">
                  {item.beforeName}：{dayTime(item.before.startsAt)}–
                  {dayTime(item.before.endsAt)}，停留 {item.before.stayMinutes}{" "}
                  分钟，等待 {item.before.waitMinutes} 分钟
                  {item.after
                    ? ` → ${item.afterName}：${dayTime(item.after.startsAt)}–${dayTime(item.after.endsAt)}，停留 ${item.after.stayMinutes} 分钟，等待 ${item.after.waitMinutes} 分钟`
                    : " → 移除"}
                </p>
              ))}
              <p className="text-sm leading-6">
                步行 {candidate.comparison.before.walking} →{" "}
                {candidate.comparison.after.walking} 分钟； 距离{" "}
                {candidate.comparison.before.distance} →{" "}
                {candidate.comparison.after.distance} 米； 最长单段{" "}
                {candidate.comparison.before.longest} →{" "}
                {candidate.comparison.after.longest} 分钟； 总等待{" "}
                {candidate.comparison.before.waiting} →{" "}
                {candidate.comparison.after.waiting} 分钟； 终点{" "}
                {dayTime(candidate.comparison.before.endArrival)} →{" "}
                {dayTime(candidate.comparison.after.endArrival)}。
                必去角色和固定时间保持，后续未锁定时刻可能随修改变化。
              </p>
              <label className="flex min-h-12 items-start gap-3 text-sm leading-6">
                <input
                  type="checkbox"
                  checked={acknowledge}
                  disabled={busy === "confirm" || uncertain}
                  onChange={(event) => setAcknowledge(event.target.checked)}
                  className="mt-1 size-5 shrink-0"
                />
                我已知悉：营业、票务和预约仍未核实；这是演示地点及路线，确认不会完成预约。
              </label>
              <button
                type="button"
                disabled={busy !== null || !acknowledge || (owner !== null && owner !== "edit")}
                onClick={() => void confirm()}
                className={button}
              >
                {busy === "confirm"
                  ? "正在保存…"
                  : uncertain
                    ? "按同一内容重试保存"
                    : "确认修改并保存新版本"}
              </button>
            </div>
          )}
          {message && (
            <p role="status" className="mt-4 text-sm leading-6 text-[#81553e]">
              {message}
            </p>
          )}
        </section>
      )}
    </>
  );
}
