"use client";

import { startTransition, useEffect, useRef, useState } from "react";
import {
  PLANNING_INTERESTS,
  planningPlaceKey,
  type PlanningFieldErrors,
  type PlanningInterest,
  type PlanningRequirements,
} from "@tripquest/application/planning";
import { reviewPlanningRequirements } from "./actions";
import {
  INTEREST_LABELS,
  type GenerationAvailability,
  type PlacePurpose,
  type PlanningAvailability,
  type ReviewReply,
  type SelectedPlace,
} from "./contracts";
import { DayDraftPanel } from "./day-draft";
import {
  PlaceDescription,
  PlaceSearch,
  primaryButton,
  secondaryButton,
} from "./place-search";

type VisitRole = "optional" | "required" | "fixed";
interface DraftVisit {
  item: SelectedPlace;
  role: VisitRole;
  stayMinutes: string;
  startsAt: string;
  endsAt: string;
}
interface Draft {
  date: string;
  startsAt: string;
  endsAt: string;
  startPlace: SelectedPlace | null;
  endPlace: SelectedPlace | null;
  interests: PlanningInterest[];
  pace: "relaxed" | "standard";
  visits: DraftVisit[];
}
const roleLabels = { optional: "可选", required: "必去", fixed: "固定事项" };
const initialDraft: Draft = {
  date: "",
  startsAt: "10:00",
  endsAt: "18:00",
  startPlace: null,
  endPlace: null,
  interests: [],
  pace: "relaxed",
  visits: [],
};

function InputField({
  id,
  label,
  value,
  type = "text",
  errors,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  type?: string;
  errors: PlanningFieldErrors;
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-2 block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type={type}
        className="journey-input min-w-0"
        value={value}
        aria-invalid={!!errors[id]}
        aria-describedby={errors[id] ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {errors[id] && (
        <p id={`${id}-error`} className="mt-2 text-sm text-[#8f392e]">
          {errors[id].join("；")}
        </p>
      )}
    </div>
  );
}

function RequirementsSummary({
  requirements,
}: {
  requirements: PlanningRequirements;
}) {
  return (
    <section
      className="mt-5 rounded-2xl border border-[#b8cfc0] bg-[#f1f7f2] p-5"
      aria-labelledby="summary-heading"
    >
      <h3 id="summary-heading" className="text-lg font-semibold">
        需求已核对
      </h3>
      <p className="mt-2 text-sm leading-6">
        下一步：根据这些需求生成一日安排。
      </p>
      <dl className="mt-4 space-y-3 text-sm leading-6">
        <div>
          <dt className="font-semibold">日期与时段</dt>
          <dd>
            {requirements.date} · {requirements.window.startsAt}–
            {requirements.window.endsAt}（杭州时间）
          </dd>
        </div>
        <div>
          <dt className="font-semibold">起终点</dt>
          <dd>
            {requirements.startPlace.place.name} →{" "}
            {requirements.endPlace.place.name}
          </dd>
        </div>
        <div>
          <dt className="font-semibold">兴趣与节奏</dt>
          <dd>
            {requirements.interests
              .map((id) => INTEREST_LABELS[id])
              .join("、") || "按已选地点"}{" "}
            · {requirements.pace === "relaxed" ? "松一点" : "标准"}
          </dd>
        </div>
        <div>
          <dt className="font-semibold">
            活动意向（{requirements.visits.length}）
          </dt>
          <dd>
            <ul className="space-y-2">
              {requirements.visits.length === 0 && (
                <li>尚未指定地点，后续按兴趣调查。</li>
              )}
              {requirements.visits.map((visit) => (
                <li key={planningPlaceKey(visit.place)}>
                  {roleLabels[visit.role]} · {visit.place.place.name} ·{" "}
                  {visit.role === "fixed"
                    ? `${visit.startsAt}–${visit.endsAt}（你填写的时间）`
                    : `预计停留 ${visit.stayMinutes} 分钟`}
                </li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-sm leading-6 text-[#52665c]">
        生成时会按步行路线核对时间；营业、票务、预约和费用需要你自行确认。
      </p>
    </section>
  );
}

export function RequirementsForm({
  availability,
  generation,
}: {
  availability: PlanningAvailability;
  generation: GenerationAvailability;
}) {
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [reply, setReply] = useState<ReviewReply | null>(null);
  // The exact token-based submission behind the ready summary; generation re-verifies it.
  const [reviewed, setReviewed] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const revision = useRef(0);
  useEffect(
    () => () => {
      revision.current += 1;
    },
    [],
  );
  const errors = reply?.status === "invalid" ? reply.fieldErrors : {};

  function change(update: (previous: Draft) => Draft) {
    revision.current += 1;
    setDraft(update);
    setReply(null);
    setChecking(false);
  }
  function editVisit(index: number, values: Partial<DraftVisit>) {
    change((previous) => ({
      ...previous,
      visits: previous.visits.map((visit, i) =>
        i === index ? { ...visit, ...values } : visit,
      ),
    }));
  }
  function select(item: SelectedPlace, purpose: PlacePurpose): string {
    if (purpose === "start" || purpose === "end") {
      change((previous) => ({
        ...previous,
        [purpose === "start" ? "startPlace" : "endPlace"]: item,
      }));
      return `已选择${purpose === "start" ? "起点" : "终点"}：${item.selection.place.name}`;
    }
    const existing = draft.visits.findIndex(
      (visit) =>
        planningPlaceKey(visit.item.selection) ===
        planningPlaceKey(item.selection),
    );
    if (existing >= 0) {
      editVisit(existing, { item });
      return "此地点已在活动列表中，请在原项修改身份与时间。";
    }
    if (draft.visits.length >= 8)
      return "最多添加 8 个活动地点，请先删除或编辑已有地点。";
    change((previous) => ({
      ...previous,
      visits: [
        ...previous.visits,
        { item, role: purpose, stayMinutes: "60", startsAt: "", endsAt: "" },
      ],
    }));
    return `已添加${roleLabels[purpose]}：${item.selection.place.name}`;
  }
  function review() {
    if (checking || !availability.enabled) return;
    const request = ++revision.current;
    setChecking(true);
    setReply(null);
    const submission = {
      schemaVersion: "planning-requirements.v1",
      cityAdcode: "330100",
      timeZone: "Asia/Shanghai",
      travelMode: "walking",
      date: draft.date,
      window: { startsAt: draft.startsAt, endsAt: draft.endsAt },
      startPlace: draft.startPlace?.token ?? "",
      endPlace: draft.endPlace?.token ?? "",
      interests: draft.interests,
      pace: draft.pace,
      visits: draft.visits.map((visit) =>
        visit.role === "fixed"
          ? {
              token: visit.item.token,
              role: visit.role,
              startsAt: visit.startsAt,
              endsAt: visit.endsAt,
            }
          : {
              token: visit.item.token,
              role: visit.role,
              stayMinutes: Number(visit.stayMinutes),
            },
      ),
    };
    startTransition(async () => {
      try {
        const result = await reviewPlanningRequirements(submission);
        if (request !== revision.current) return;
        setReply(result);
        setReviewed(result.status === "ready" ? submission : null);
        if (result.status === "invalid") {
          const first = Object.keys(result.fieldErrors)[0];
          requestAnimationFrame(() => {
            if (request !== revision.current) return;
            for (const path of Object.keys(result.fieldErrors)) {
              const details = document.getElementById(path)?.closest("details");
              if (details) details.open = true;
            }
            (
              document.getElementById(first) ??
              document.getElementById("requirements-errors")
            )?.focus();
          });
        }
      } catch {
        if (request === revision.current) {
          setReply({
            status: "unavailable",
            message: "暂时无法核对需求，请稍后重试",
          });
        }
      } finally {
        if (request === revision.current) setChecking(false);
      }
    });
  }

  return (
    <form
      noValidate
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        review();
      }}
    >
      <p
        role="status"
        className="rounded-2xl border border-[#dce8e0] bg-[#edf6ef] p-4 text-sm leading-6"
      >
        {availability.message}
      </p>
      <section
        className="rounded-3xl border border-[#dce8e0] bg-white p-5 sm:p-6"
        aria-labelledby="day-heading"
      >
        <h2 id="day-heading" className="text-xl font-semibold">
          1. 这一天怎么安排
        </h2>
        <p className="mt-2 text-sm leading-6 text-[#52665c]">
          杭州 · 一天 · 步行，适合城市局部区域。
        </p>
        <div className="mt-5 space-y-5">
          <InputField
            id="date"
            label="出行日期"
            type="date"
            value={draft.date}
            errors={errors}
            onChange={(date) => change((previous) => ({ ...previous, date }))}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <InputField
              id="window.startsAt"
              label="出发时间"
              type="time"
              value={draft.startsAt}
              errors={errors}
              onChange={(startsAt) =>
                change((previous) => ({ ...previous, startsAt }))
              }
            />
            <InputField
              id="window.endsAt"
              label="最晚抵达终点"
              type="time"
              value={draft.endsAt}
              errors={errors}
              onChange={(endsAt) =>
                change((previous) => ({ ...previous, endsAt }))
              }
            />
          </div>
          <div className="space-y-3">
            {(["startPlace", "endPlace"] as const).map((field) => (
              <div
                key={field}
                id={field}
                tabIndex={-1}
                className="rounded-2xl border border-[#dce8e0] p-4"
              >
                <p className="mb-2 text-sm font-semibold">
                  {field === "startPlace" ? "起点" : "终点"}（必选）
                </p>
                {draft[field] ? (
                  <PlaceDescription item={draft[field]} />
                ) : (
                  <p className="text-sm text-[#52665c]">
                    在下方搜索地点并明确选择
                  </p>
                )}
                {draft[field] && (
                  <button
                    type="button"
                    className={`${secondaryButton} mt-3`}
                    onClick={() =>
                      change((previous) => ({ ...previous, [field]: null }))
                    }
                  >
                    移除{field === "startPlace" ? "起点" : "终点"}
                  </button>
                )}
                {errors[field] && (
                  <p className="mt-2 text-sm text-[#8f392e]">
                    {errors[field].join("；")}
                  </p>
                )}
              </div>
            ))}
            <button
              type="button"
              className={secondaryButton}
              disabled={!draft.startPlace}
              onClick={() =>
                change((previous) => ({
                  ...previous,
                  endPlace: previous.startPlace,
                }))
              }
            >
              回到起点：将终点设为当前起点
            </button>
          </div>
          <fieldset id="interests" tabIndex={-1}>
            <legend className="text-sm font-semibold">
              兴趣（没有活动地点时至少选择一项）
            </legend>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {PLANNING_INTERESTS.map((id) => (
                <label
                  key={id}
                  className="flex min-h-12 items-center gap-3 rounded-2xl border border-[#dce8e0] p-3 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={draft.interests.includes(id)}
                    onChange={(event) =>
                      change((previous) => ({
                        ...previous,
                        interests: event.target.checked
                          ? [...previous.interests, id]
                          : previous.interests.filter((item) => item !== id),
                      }))
                    }
                  />
                  {INTEREST_LABELS[id]}
                </label>
              ))}
            </div>
            {errors.interests && (
              <p className="mt-2 text-sm text-[#8f392e]">
                {errors.interests.join("；")}
              </p>
            )}
          </fieldset>
          <div>
            <label htmlFor="pace" className="mb-2 block text-sm font-medium">
              游玩节奏
            </label>
            <select
              id="pace"
              className="journey-input"
              value={draft.pace}
              onChange={(event) =>
                change((previous) => ({
                  ...previous,
                  pace: event.target.value as Draft["pace"],
                }))
              }
            >
              <option value="relaxed">松一点</option>
              <option value="standard">标准</option>
            </select>
          </div>
        </div>
      </section>
      <PlaceSearch
        enabled={availability.enabled}
        interests={draft.interests}
        onSelect={select}
      />
      <section
        id="visits"
        tabIndex={-1}
        className="rounded-3xl border border-[#dce8e0] bg-white p-5 sm:p-6"
        aria-labelledby="visits-heading"
      >
        <h2 id="visits-heading" className="text-lg font-semibold">
          已选活动（{draft.visits.length}/8）
        </h2>
        <p className="mt-2 text-sm leading-6 text-[#52665c]">
          可选地点可以舍弃；必去必须安排；固定事项遵守你填写的时间。起终点不自动算活动。
        </p>
        {draft.visits.length === 0 && (
          <p className="mt-4 text-sm">可以先留空，后续会根据兴趣调查地点。</p>
        )}
        {errors.visits && (
          <p className="mt-3 text-sm text-[#8f392e]">
            {errors.visits.join("；")}
          </p>
        )}
        <ul className="mt-4 space-y-4">
          {draft.visits.map((visit, index) => (
            <li
              key={planningPlaceKey(visit.item.selection)}
              className="space-y-4 rounded-2xl border border-[#dce8e0] p-4"
            >
              <PlaceDescription item={visit.item} />
              <div id={`visits.${index}.place`} tabIndex={-1}>
                {errors[`visits.${index}.place`] && (
                  <p className="text-sm text-[#8f392e]">
                    {errors[`visits.${index}.place`].join("；")}
                  </p>
                )}
              </div>
              <label
                className="block text-sm font-medium"
                htmlFor={`visits.${index}.role`}
              >
                地点身份
              </label>
              <select
                id={`visits.${index}.role`}
                className="journey-input"
                value={visit.role}
                onChange={(event) => {
                  const role = event.target.value as VisitRole;
                  editVisit(index, {
                    role,
                    stayMinutes:
                      visit.role === "fixed" && role !== "fixed"
                        ? ""
                        : visit.stayMinutes,
                    startsAt:
                      role === "fixed" && visit.role !== "fixed"
                        ? ""
                        : visit.startsAt,
                    endsAt:
                      role === "fixed" && visit.role !== "fixed"
                        ? ""
                        : visit.endsAt,
                  });
                }}
              >
                <option value="optional">可选</option>
                <option value="required">必去</option>
                <option value="fixed">固定事项</option>
              </select>
              {visit.role === "fixed" ? (
                <details>
                  <summary className="cursor-pointer py-3 text-sm font-medium">
                    填写固定时间（必填）
                  </summary>
                  <div className="space-y-4">
                    <InputField
                      id={`visits.${index}.startsAt`}
                      label="固定开始时间"
                      type="time"
                      value={visit.startsAt}
                      errors={errors}
                      onChange={(startsAt) => editVisit(index, { startsAt })}
                    />
                    <InputField
                      id={`visits.${index}.endsAt`}
                      label="固定结束时间"
                      type="time"
                      value={visit.endsAt}
                      errors={errors}
                      onChange={(endsAt) => editVisit(index, { endsAt })}
                    />
                  </div>
                </details>
              ) : (
                <InputField
                  id={`visits.${index}.stayMinutes`}
                  label="预计停留（15–240 分钟）"
                  type="number"
                  value={visit.stayMinutes}
                  errors={errors}
                  onChange={(stayMinutes) => editVisit(index, { stayMinutes })}
                />
              )}
              {visit.role !== "fixed" && visit.stayMinutes === "" && (
                <p className="text-sm text-[#8f392e]">
                  请重新确认预计停留时间。
                </p>
              )}
              <button
                type="button"
                className={secondaryButton}
                onClick={() =>
                  change((previous) => ({
                    ...previous,
                    visits: previous.visits.filter((_, i) => i !== index),
                  }))
                }
              >
                移除此活动
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section
        className="rounded-3xl border border-[#dce8e0] bg-white p-5 sm:p-6"
        aria-labelledby="review-heading"
      >
        <h2 id="review-heading" className="text-xl font-semibold">
          3. 核对需求
        </h2>
        <p className="mt-2 text-sm leading-6 text-[#52665c]">
          核对日期、地点与硬要求；交通、营业与最终组合留待生成行程时检查。
        </p>
        <button
          type="submit"
          className={`${primaryButton} mt-5 w-full sm:w-auto`}
          disabled={!availability.enabled || checking}
        >
          {checking ? "正在核对…" : "核对需求"}
        </button>
        <div
          id="requirements-errors"
          tabIndex={-1}
          className="mt-4 text-sm leading-6 text-[#8f392e]"
          role="alert"
        >
          {reply?.status === "invalid" && (
            <ul>
              {Object.entries(reply.fieldErrors).map(([path, messages]) => (
                <li key={path}>{messages.join("；")}</li>
              ))}
            </ul>
          )}
          {reply?.status === "unavailable" && <p>{reply.message}</p>}
        </div>
        <div aria-live="polite">
          {reply?.status === "ready" && (
            <RequirementsSummary requirements={reply.requirements} />
          )}
        </div>
        {reply?.status === "ready" && reviewed !== null && (
          <DayDraftPanel submission={reviewed} availability={generation} />
        )}
      </section>
    </form>
  );
}
