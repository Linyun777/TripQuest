"use client";

import { ArrowRight, CalendarCheck, Map, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../_ui/button";
import { Sheet } from "../_ui/sheet";
import { Composer } from "../plan/composer";
import { ProgressSteps } from "../plan/progress-steps";
import {
  FIRST_REQUEST,
  LAKE_REQUEST,
  LATE_REQUEST,
  TEA_REQUEST,
  decideDemoOffer,
  generateDemo,
  newDemoConversation,
  sendDemoMessage,
  type DemoConversation,
} from "./demo-conversation";
import { AdjustmentPreview, DemoPlanPanel, PlanningEvidence, Requirements } from "./demo-results";
import { stopsForInterest } from "./demo-schedule";

const DEMO_PACING = {
  reply: [
    { text: "正在理解这条消息…", durationMs: 850 },
  ],
  planning: [
    { text: "按你的兴趣筛选示例地点", durationMs: 620 },
    { text: "比较不同地点组合和步行顺序", durationMs: 1300 },
    { text: "核对导览时间和最晚到站时间", durationMs: 880 },
  ],
  adjustment: [
    { text: "读取当前行程和这轮变更", durationMs: 640 },
    { text: "试排调整后的示例路线", durationMs: 1360 },
    { text: "核对预约与返程时间", durationMs: 800 },
  ],
} as const;

type DemoRun = {
  kind: keyof typeof DEMO_PACING;
  step: number;
  next: DemoConversation;
  userText?: string;
};

function suggestionsFor(state: DemoConversation) {
  if (!state.plan) {
    if (state.requirements.departure !== undefined && state.requirements.returnBy === undefined) {
      return [{ label: "17 点前到", text: "17:00 前到" }];
    }
    if (state.requirements.interests.length || state.requirements.namedStops.length) return [];
    return [
      { label: "小吃与人文", text: FIRST_REQUEST },
      { label: "沿湖散步与人文", text: LAKE_REQUEST },
    ];
  }
  if (state.offer) return [];
  if (state.report.completedStop && state.report.resumeAt === undefined) {
    return [{ label: "12:50 从这里继续", text: "12:50 从这里继续" }];
  }
  if (state.plan.resumeFrom) return [{ label: "试试 13:55 才能走", text: LATE_REQUEST }];

  const nextStop = state.plan.stops[1];
  const replacement = nextStop && stopsForInterest("tea").includes(nextStop)
    ? TEA_REQUEST.replace("茶馆", "沿湖散步")
    : TEA_REQUEST;
  const changeInterest = state.plan.interests.includes("lake")
    ? "想尝尝当地小吃，也想看看当地文化"
    : "想沿湖散步，也想看看当地文化";
  return [
    ...(state.plan.stops.length ? [{ label: "试试途中换一站", text: replacement }] : []),
    ...(!state.report.completedStop ? [{ label: "换个兴趣试排", text: changeInterest }] : []),
  ];
}

function DemoChat({ onReset }: { onReset: () => void }) {
  const [state, setState] = useState(newDemoConversation);
  const [run, setRun] = useState<DemoRun | null>(null);
  const [suggestion, setSuggestion] = useState<{ text: string; nonce: number } | null>(null);
  const [openPlan, setOpenPlan] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const hints = suggestionsFor(state);
  const messages = run?.userText
    ? [...state.messages, { role: "user" as const, text: run.userText }]
    : state.messages;
  const hasMessages = messages.length > 0;
  const offer = run ? null : state.offer;

  // Only the presentation is delayed. The computed result replaces the progress together.
  useEffect(() => {
    if (!run) return;
    const stages = DEMO_PACING[run.kind];
    const timeout = window.setTimeout(() => {
      if (run.step + 1 < stages.length) {
        setRun({ ...run, step: run.step + 1 });
      } else {
        setState(run.next);
        setRun(null);
      }
    }, stages[run.step].durationMs);
    return () => window.clearTimeout(timeout);
  }, [run]);

  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages.length, run?.step]);

  function send(text: string) {
    if (run) return;
    const next = sendDemoMessage(state, text);
    if (next === state) return;
    const answer = next.messages.at(-1);
    const kind = answer?.role === "assistant" && answer.work === "adjustment" ? "adjustment" : "reply";
    setRun((current) => current ?? { kind, step: 0, next, userText: text });
  }

  function generate() {
    if (run) return;
    const next = generateDemo(state);
    if (next !== state) {
      setRun((current) => current ?? { kind: "planning", step: 0, next });
    }
  }

  const plan = state.plan && (
    <DemoPlanPanel
      current={state.plan}
      offer={offer}
      completedStop={state.report.completedStop}
    />
  );

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 border-line lg:border-x">
      <section aria-label="对话" className="flex min-w-0 flex-1 flex-col">
        <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto w-full max-w-2xl px-4 py-5 sm:px-7 sm:py-8">
            <h1 className="font-heading text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
              松风湖一日游
            </h1>
            {!hasMessages && (
              <div className="mt-5 border-l-2 border-lake-200 pl-4">
                <p className="text-base font-medium text-ink">想怎么过这一天？</p>
                <p className="mt-1 max-w-md text-sm leading-6 text-ink-soft">
                  告诉我什么时候出发、喜欢怎么玩。我会挑选地点、比较步行路线，帮你赶上导览和返程。
                </p>
                <p className="mt-3 flex items-center gap-2 text-sm text-sun-700">
                  <CalendarCheck className="size-4" />
                  博物馆导览已预约，14:00–15:00
                </p>
              </div>
            )}

            <div role="log" aria-label="示例对话消息" className="mt-5 space-y-3">
              {messages.map(({ role, text }, index) => (
                <div key={index} className={role === "user" ? "flex justify-end" : "flex"}>
                  <p className={role === "user"
                    ? "max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-lake-600 px-4 py-2.5 text-sm leading-6 text-white"
                    : "max-w-[93%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-surface px-4 py-2.5 text-sm leading-6 text-ink"
                  }>
                    {text}
                  </p>
                </div>
              ))}
              {state.messages.length > 0 && !state.plan && (
                <Requirements
                  requirements={state.requirements}
                  onGenerate={run ? undefined : generate}
                />
              )}
              {offer && (
                <AdjustmentPreview
                  offer={offer}
                  onDecision={(accept) => setState((current) => decideDemoOffer(current, offer, accept))}
                />
              )}
              {state.plan && !run && !offer && !state.plan.resumeFrom && <PlanningEvidence plan={state.plan} />}
            </div>
            {run && (
              <div className="mt-3">
                {run.kind === "reply" ? (
                  <p role="status" className="w-fit rounded-2xl rounded-bl-md bg-surface px-4 py-2.5 text-sm text-ink-soft">
                    {DEMO_PACING.reply[0].text}
                  </p>
                ) : (
                  <ProgressSteps
                    running
                    steps={DEMO_PACING[run.kind].slice(0, run.step + 1).map(({ text }, index) => ({
                      key: text,
                      text,
                      state: index === run.step ? "active" : "done",
                    }))}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-line bg-paper px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5 sm:px-7">
          <div className="mx-auto max-w-xl space-y-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {hints.map((hint) => (
                <Button
                  key={hint.label}
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="min-h-10"
                  disabled={run !== null}
                  onClick={() => setSuggestion((previous) => ({ text: hint.text, nonce: (previous?.nonce ?? 0) + 1 }))}
                >
                  {hint.label}
                  <ArrowRight />
                </Button>
              ))}
              {plan && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="min-h-10 lg:hidden"
                  onClick={() => setOpenPlan(true)}
                >
                  <Map />
                  查看行程
                </Button>
              )}
              {hasMessages && (
                <Button type="button" variant="ghost" size="sm" className="ml-auto min-h-10" onClick={onReset}>
                  <RotateCcw />
                  重新体验
                </Button>
              )}
            </div>
            <Composer
              onSend={send}
              disabled={run !== null}
              suggestion={suggestion}
              placeholder={state.plan ? "想换一站，还是调整时间？" : "说说你想怎么过这一天…"}
            />
            <p className="text-xs leading-4 text-ink-soft">示例使用虚构地点，选点和排程在浏览器完成</p>
          </div>
        </div>
      </section>

      {plan && (
        <aside aria-label="行程和地图" className="hidden w-[400px] shrink-0 overflow-y-auto border-l border-line bg-surface px-5 py-6 lg:block">
          {plan}
        </aside>
      )}
      <Sheet open={openPlan} onOpenChange={setOpenPlan} title="行程与地图">
        {plan}
      </Sheet>
    </main>
  );
}

export function DemoJourney() {
  const [session, setSession] = useState(0);
  return <DemoChat key={session} onReset={() => setSession((value) => value + 1)} />;
}
