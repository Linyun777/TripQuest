"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";

import { createJourneyAction } from "./actions";
import {
  emptyActivity,
  initialJourneyFormState,
  type JourneyFormActivity,
} from "./form-state";

interface ActivityRow {
  readonly key: number;
  readonly value: JourneyFormActivity;
}

export function JourneyForm() {
  const [state, formAction, pending] = useActionState(
    createJourneyAction,
    initialJourneyFormState,
  );
  const nextKey = useRef(1);
  const [title, setTitle] = useState(state.values.title);
  const [date, setDate] = useState(state.values.date);
  const [rows, setRows] = useState<ActivityRow[]>([
    { key: 0, value: emptyActivity },
  ]);

  function updateActivity(key: number, change: Partial<JourneyFormActivity>) {
    setRows((current) =>
      current.map((row) =>
        row.key === key ? { ...row, value: { ...row.value, ...change } } : row,
      ),
    );
  }

  function removeActivity(key: number) {
    setRows((current) => current.filter((row) => row.key !== key));
  }

  function addActivity() {
    setRows((current) =>
      current.length >= 8
        ? current
        : [...current, { key: nextKey.current++, value: { ...emptyActivity } }],
    );
  }

  function errorsFor(path: string) {
    return state.fieldErrors[path] ?? [];
  }

  return (
    <form action={formAction} noValidate className="space-y-8">
      <fieldset disabled={pending} className="space-y-8 disabled:opacity-75">
        <section className="rounded-3xl border border-[#dce8e0] bg-white p-5 shadow-[0_18px_45px_-38px_rgba(22,57,42,0.55)] sm:p-7">
          <div className="mb-6 flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl bg-[#e6f2eb] text-sm font-bold text-[#236d55]">01</span>
            <h2 className="text-lg font-semibold">行程信息</h2>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="journey-title" className="mb-2 block text-sm font-medium">行程名称</label>
              <input
                id="journey-title"
                name="title"
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={80}
                autoComplete="off"
                placeholder="例如：虚构市的一天"
                aria-invalid={errorsFor("title").length > 0}
                aria-describedby={errorsFor("title").length > 0 ? "title-error" : undefined}
                className="journey-input"
              />
              <FieldError id="title-error" messages={errorsFor("title")} />
            </div>
            <div>
              <label htmlFor="journey-date" className="mb-2 block text-sm font-medium">行程日期</label>
              <input
                id="journey-date"
                name="date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                aria-invalid={errorsFor("date").length > 0}
                aria-describedby={errorsFor("date").length > 0 ? "date-error" : undefined}
                className="journey-input"
              />
              <FieldError id="date-error" messages={errorsFor("date")} />
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">时间标准</p>
              <div className="flex min-h-12 items-center rounded-2xl border border-[#dce8e0] bg-[#f7f9f7] px-4 text-sm text-[#476357]">
                中国标准时间 · Asia/Shanghai
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-[#dce8e0] bg-white p-5 shadow-[0_18px_45px_-38px_rgba(22,57,42,0.55)] sm:p-7">
          <div className="mb-2 flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl bg-[#e6f2eb] text-sm font-bold text-[#236d55]">02</span>
            <h2 className="text-lg font-semibold">按顺序安排事项</h2>
          </div>
          <p className="mb-6 text-sm leading-6 text-[#62736c]">填写 1–8 项。时间按顺序排列，事项之间不能重叠。</p>
          <FieldError id="activities-error" messages={errorsFor("activities")} />

          <div className="space-y-4">
            {rows.map((row, index) => {
              const base = `activities.${index}`;
              const nameError = errorsFor(`${base}.placeName`);
              const startError = errorsFor(`${base}.startsAt`);
              const endError = errorsFor(`${base}.endsAt`);
              const kindError = errorsFor(`${base}.kind`);
              const priorityError = errorsFor(`${base}.priority`);
              const fixed = row.value.kind === "reservation";
              return (
                <div key={row.key} className="rounded-2xl border border-[#dce8e0] bg-[#fbfcfa] p-4 sm:p-5">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h3 className="font-semibold">事项 {index + 1}</h3>
                    <button
                      type="button"
                      onClick={() => removeActivity(row.key)}
                      className="min-h-11 rounded-xl px-3 text-sm font-medium text-[#8b4d41] transition-colors hover:bg-[#f8ebe6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8b4d41]"
                      aria-label={`移除事项 ${index + 1}`}
                    >
                      移除
                    </button>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <label htmlFor={`activity-${row.key}-name`} className="mb-2 block text-sm font-medium">地点名称</label>
                      <input
                        id={`activity-${row.key}-name`}
                        name={`${base}.placeName`}
                        type="text"
                        value={row.value.placeName}
                        onChange={(event) => updateActivity(row.key, { placeName: event.target.value })}
                        maxLength={80}
                        autoComplete="off"
                        placeholder="例如：城市博物馆"
                        aria-invalid={nameError.length > 0}
                        aria-describedby={nameError.length > 0 ? `activity-${row.key}-name-error` : undefined}
                        className="journey-input"
                      />
                      <FieldError id={`activity-${row.key}-name-error`} messages={nameError} />
                    </div>
                    <div>
                      <label htmlFor={`activity-${row.key}-start`} className="mb-2 block text-sm font-medium">开始时间</label>
                      <input
                        id={`activity-${row.key}-start`}
                        name={`${base}.startsAt`}
                        type="time"
                        value={row.value.startsAt}
                        onChange={(event) => updateActivity(row.key, { startsAt: event.target.value })}
                        aria-invalid={startError.length > 0}
                        aria-describedby={startError.length > 0 ? `activity-${row.key}-start-error` : undefined}
                        className="journey-input"
                      />
                      <FieldError id={`activity-${row.key}-start-error`} messages={startError} />
                    </div>
                    <div>
                      <label htmlFor={`activity-${row.key}-end`} className="mb-2 block text-sm font-medium">结束时间</label>
                      <input
                        id={`activity-${row.key}-end`}
                        name={`${base}.endsAt`}
                        type="time"
                        value={row.value.endsAt}
                        onChange={(event) => updateActivity(row.key, { endsAt: event.target.value })}
                        aria-invalid={endError.length > 0}
                        aria-describedby={endError.length > 0 ? `activity-${row.key}-end-error` : undefined}
                        className="journey-input"
                      />
                      <FieldError id={`activity-${row.key}-end-error`} messages={endError} />
                    </div>
                    <div>
                      <label htmlFor={`activity-${row.key}-kind`} className="mb-2 block text-sm font-medium">事项类型</label>
                      <select
                        id={`activity-${row.key}-kind`}
                        name={`${base}.kind`}
                        value={row.value.kind}
                        onChange={(event) => updateActivity(row.key, {
                          kind: event.target.value,
                          priority: event.target.value === "reservation" ? "high" : "normal",
                        })}
                        aria-invalid={kindError.length > 0}
                        aria-describedby={kindError.length > 0 ? `activity-${row.key}-kind-error` : undefined}
                        className="journey-input"
                      >
                        <option value="activity">普通活动</option>
                        <option value="reservation">固定预约</option>
                      </select>
                      <FieldError id={`activity-${row.key}-kind-error`} messages={kindError} />
                    </div>
                    <div>
                      {fixed ? (
                        <>
                          <p className="mb-2 text-sm font-medium">优先级</p>
                          <div className="flex min-h-12 items-center rounded-2xl border border-[#eddfd5] bg-[#fff8f1] px-4 text-sm text-[#81553e]">高 · 固定预约自动锁定</div>
                          <input type="hidden" name={`${base}.priority`} value="high" />
                        </>
                      ) : (
                        <>
                          <label htmlFor={`activity-${row.key}-priority`} className="mb-2 block text-sm font-medium">优先级</label>
                          <select
                            id={`activity-${row.key}-priority`}
                            name={`${base}.priority`}
                            value={row.value.priority}
                            onChange={(event) => updateActivity(row.key, { priority: event.target.value })}
                            aria-invalid={priorityError.length > 0}
                            aria-describedby={priorityError.length > 0 ? `activity-${row.key}-priority-error` : undefined}
                            className="journey-input"
                          >
                            <option value="normal">普通</option>
                            <option value="high">高</option>
                            <option value="low">低</option>
                          </select>
                        </>
                      )}
                      <FieldError id={`activity-${row.key}-priority-error`} messages={priorityError} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={addActivity}
            disabled={rows.length >= 8}
            className="mt-5 min-h-12 w-full rounded-2xl border border-dashed border-[#8bb6a0] bg-[#f3f9f5] px-4 font-medium text-[#236d55] transition-colors hover:bg-[#e9f4ed] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#236d55] disabled:cursor-not-allowed disabled:opacity-50"
          >
            ＋ 添加事项 {rows.length}/8
          </button>
        </section>

        <div className="rounded-2xl border border-[#eddfd5] bg-[#fff8f1] p-4 text-sm leading-6 text-[#81553e]">
          地点与预约来自你的录入，尚未核验地图、营业时间、路线或现实可达性。
        </div>

        <div aria-live="polite" className="space-y-4">
          {state.formError && (
            <p role="alert" className="rounded-2xl border border-[#ebc7c0] bg-[#fff1ee] p-4 text-sm text-[#9b3f32]">
              {state.formError}
            </p>
          )}
          {pending && <p className="text-sm text-[#62736c]">正在保存行程…</p>}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="submit"
            disabled={pending}
            className="min-h-12 rounded-2xl bg-[#236d55] px-7 font-semibold text-white shadow-[0_12px_30px_-20px_rgba(22,57,42,0.8)] transition-colors hover:bg-[#195740] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#236d55] disabled:cursor-wait disabled:opacity-60"
          >
            {pending ? "正在保存…" : "保存一日行程"}
          </button>
          <Link href="/" className="inline-flex min-h-12 items-center justify-center rounded-2xl px-5 text-sm font-medium text-[#476357] hover:bg-[#e9f4ed]">返回首页</Link>
        </div>
      </fieldset>
    </form>
  );
}

function FieldError({ id, messages }: { id: string; messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return <p id={id} className="mt-2 text-sm text-[#a14435]">{messages.join("；")}</p>;
}
