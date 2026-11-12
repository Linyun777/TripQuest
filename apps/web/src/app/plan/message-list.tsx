"use client";

import { Bookmark, BookOpen, ChevronDown, ExternalLink, Globe, Info, ListChecks, LoaderCircle, MapPin, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../_ui/button";
import { cn } from "../_ui/cn";
import { AdjustCard } from "./adjust-card";
import { ChoicesCard } from "./choices-card";
import { OutingBar, OutingChangeCard, OutingDayCard } from "./outing-day";
import { PlanCard } from "./plan-card";
import { PlatformLinks } from "./platform-links";
import { ProgressSteps } from "./progress-steps";
import { RequirementsCard, SupersededCard, type CardEdit } from "./requirements-card";
import type {
  AdjustCardView,
  ChatMessageView,
  ChoiceOptionView,
  ChoicesView,
  KnowledgePassageView,
  MessageSourceView,
  OutingChangeView,
  OutingDayView,
  PlanCardView,
  RequirementsCardView,
} from "./view-models";
import { EASE_OUT } from "../_ui/motion";

export type MessageActions = {
  onChoosePlace?: (target: string, placeId: string) => void;
  onEdit?: CardEdit;
  onUseLocation?: () => void;
  locating?: boolean;
  onStart?: (card: RequirementsCardView) => void;
  onSave?: (plan: PlanCardView) => void;
  onReplan?: (plan: PlanCardView) => void;
  starting?: boolean;
  savingRunId?: string | null;
  /** 方案卡点击后在当前对话内查询出发须知。 */
  conversationId?: string | null;
  highlightStart?: boolean;
  /** 短途候选支持选定当前地点或换一批。 */
  onPick?: (view: ChoicesView, option: ChoiceOptionView) => void;
  onRefresh?: (view: ChoicesView) => void;
  /** V2.9：“要记住吗？”卡片上点“记住”或“不用”；返回出错时的提示。 */
  onPreference?: (messageId: string, decision: "save" | "dismiss") => Promise<string | null>;
  /** 只为最新调整卡提供确认动作。 */
  onConfirmAdjust?: (card: AdjustCardView) => void;
  /** V2.11 出游：分到各天，或把一项移到别的天。 */
  onAllocate?: (move?: { target: string; day: number }) => void;
  allocating?: boolean;
  confirmingRunId?: string | null;
  /** V2.11 出游：重排某一天；整趟的保存与继续（显示在对话末尾）。 */
  onRedoDay?: (view: OutingDayView) => void;
  onConfirmOutingChange?: (view: OutingChangeView) => void;
  /** V3.5：停止正在跑的规划。 */
  onStop?: () => void;
  stopping?: boolean;
  /** V3.2 审查建议：采纳（走改动流程，确认才保存）或忽略；返回出错时的提示。 */
  onSuggestion?: (messageId: string, index: number, decision: "adopt" | "dismiss") => Promise<string | null>;
  /** 日常遇到外地时的“切到出游”（带上那些地点）。 */
  onSwitchToOuting?: () => void;
  confirmingChange?: string | null;
  outing?: Parameters<typeof OutingBar>[0];
};

/** 新消息追加到底部并跟随滚动，进入动效只作用于新消息。 */
export function MessageList({
  messages,
  actions = {},
  thinking = false,
  thinkingStep = null,
}: {
  messages: readonly ChatMessageView[];
  actions?: MessageActions;
  thinking?: boolean;
  /** 在等待圆点旁显示当前查询步骤，流进度变化不追加成正式消息。 */
  thinkingStep?: string | null;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, thinking, thinkingStep]);

  return (
    <div className="space-y-4">
      <AnimatePresence initial={false}>
        {messages.map((message) => (
          <motion.div
            key={message.id}
            // 消息只在末尾追加，无需每条流式进度都重新测量布局；
            // 使用完整 transform 动画减轻页面忙碌时的主线程负担。
            initial={{ opacity: 0, transform: "translateY(12px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            transition={{ duration: 0.36, ease: EASE_OUT }}
          >
            <Message message={message} actions={actions} />
          </motion.div>
        ))}
        {actions.outing && (
          <motion.div key="outing-bar" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <OutingBar {...actions.outing} />
          </motion.div>
        )}
        {thinking && (
          <motion.div key="thinking" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Assistant>
              <span className="inline-flex min-w-0 max-w-full items-center gap-2 py-1" aria-live="polite">
                <span className="inline-flex shrink-0 gap-1" aria-label="正在思考">
                  {[0, 1, 2].map((dot) => (
                    <motion.span
                      key={dot}
                      className="size-1.5 rounded-full bg-ink-faint"
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{ duration: 1.2, repeat: Infinity, delay: dot * 0.18 }}
                    />
                  ))}
                </span>
                <AnimatePresence mode="wait" initial={false}>
                  {thinkingStep && (
                    <motion.span
                      key={thinkingStep}
                      initial={{ opacity: 0, transform: "translateY(4px)" }}
                      animate={{ opacity: 1, transform: "translateY(0px)" }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.18, ease: EASE_OUT }}
                      className="truncate text-sm text-ink-faint"
                    >
                      {thinkingStep}…
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>
            </Assistant>
          </motion.div>
        )}
      </AnimatePresence>
      <div ref={end} />
    </div>
  );
}

const PREFERENCE_CATEGORY: Record<Extract<ChatMessageView, { kind: "preference_proposal" }>["category"], string> = {
  food: "饮食",
  pace: "节奏",
  travel: "出行",
  interest: "兴趣",
  other: "其他",
};

/** V2.9：提议记住一条长期偏好。点“记住”才保存；保存后可以在“我的偏好”里修改或删除。 */
function PreferenceProposal({
  message,
  onDecide,
}: {
  message: Extract<ChatMessageView, { kind: "preference_proposal" }>;
  onDecide?: (messageId: string, decision: "save" | "dismiss") => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(decision: "save" | "dismiss") {
    if (!onDecide || busy) return;
    setBusy(true);
    setError(await onDecide(message.id, decision));
    setBusy(false);
  }
  return (
    <Assistant>
      <div className="max-w-md rounded-(--radius-field) border border-line bg-surface px-3.5 py-3">
        <p className="flex items-center gap-1.5 text-xs text-ink-faint">
          <Bookmark className="size-3.5" />
          长期偏好 · {PREFERENCE_CATEGORY[message.category]}
        </p>
        <p className="mt-1 text-[15px] text-ink">{message.text}</p>
        {message.status === "pending" ? (
          <>
            <p className="mt-1 text-xs text-ink-faint">要记住吗？记住后，以后的规划和建议会参考它。</p>
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" className="h-8 px-3" onClick={() => void decide("save")} disabled={busy || !onDecide}>
                {busy ? <LoaderCircle className="animate-spin" /> : <Bookmark />}
                记住
              </Button>
              <Button size="sm" variant="secondary" className="h-8 px-3" onClick={() => void decide("dismiss")} disabled={busy || !onDecide}>
                不用
              </Button>
            </div>
            {error && <p className="mt-1.5 text-xs text-sun-700">{error}</p>}
          </>
        ) : message.status === "saved" ? (
          <p className="mt-1.5 text-xs text-ink-faint">
            已记住，可以在
            <a href="/preferences" className="mx-0.5 underline decoration-line-strong underline-offset-2 hover:text-lake-700">我的偏好</a>
            里修改或删除。
          </p>
        ) : (
          <p className="mt-1.5 text-xs text-ink-faint">没有记住。</p>
        )}
      </div>
    </Assistant>
  );
}

const ASSESSMENT_MARK = {
  met: { mark: "✓", word: "做到了", tone: "text-lake-700" },
  partly: { mark: "△", word: "部分做到", tone: "text-amber-700" },
  unmet: { mark: "✕", word: "没做到", tone: "text-red-700" },
  unknown: { mark: "?", word: "看不出来", tone: "text-ink-faint" },
} as const;

/** V4.7：“这趟符合你的要求吗”：一句总评、逐条清单和整体问题（不显示分数）。 */
function TripAssessment({ assessment }: { assessment: NonNullable<Extract<ChatMessageView, { kind: "outing_review" }>["assessment"]> }) {
  return (
    <div className="mb-2 max-w-md rounded-(--radius-field) border border-line bg-surface px-3.5 py-3">
      <p className="flex items-center gap-1.5 text-xs text-ink-faint">
        <ListChecks className="size-3.5" />
        这趟符合你的要求吗
      </p>
      <p className="mt-1.5 text-[15px] text-ink">{assessment.summary}</p>
      {assessment.items.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {assessment.items.map((item, index) => (
            <li key={index} className="flex gap-2 text-[13px] leading-5">
              <span aria-hidden className={cn("w-3.5 shrink-0 text-center font-medium", ASSESSMENT_MARK[item.status].tone)}>{ASSESSMENT_MARK[item.status].mark}</span>
              <span className="min-w-0 text-ink-soft">
                <span className="text-ink">{item.text}</span>
                <span className={cn("ml-1.5", ASSESSMENT_MARK[item.status].tone)}>{ASSESSMENT_MARK[item.status].word}</span>
                {item.note && <span className="block text-xs text-ink-faint">{item.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {assessment.issues.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-line pt-2">
          {assessment.issues.map((issue, index) => (
            <li key={index} className="text-[13px] leading-5 text-ink-soft">第 {issue.day} 天：{issue.note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** V3.2：审查给的建议。每条一句话和理由；采纳后重排受影响的天、显示前后，确认才保存。 */
function ReviewSuggestions({
  message,
  onDecide,
}: {
  message: Extract<ChatMessageView, { kind: "outing_review" }>;
  onDecide?: (messageId: string, index: number, decision: "adopt" | "dismiss") => Promise<string | null>;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function decide(index: number, decision: "adopt" | "dismiss") {
    if (!onDecide || busy !== null) return;
    setBusy(index);
    setError(await onDecide(message.id, index, decision));
    setBusy(null);
  }
  return (
    <Assistant>
      {message.assessment && <TripAssessment assessment={message.assessment} />}
      {message.suggestions.length > 0 && (
      <div className="max-w-md rounded-(--radius-field) border border-line bg-surface px-3.5 py-3">
        <p className="flex items-center gap-1.5 text-xs text-ink-faint">
          <ListChecks className="size-3.5" />
          {/* V3.3：也有换住处的候选（不是审查 Agent 给的）。 */}
          排好后的建议
        </p>
        <ul className="mt-1.5 divide-y divide-line">
          {message.suggestions.map((item) => (
            <li key={item.index} className="py-2 first:pt-0 last:pb-0">
              <p className="text-[15px] text-ink">{item.text}</p>
              <p className="mt-0.5 text-xs text-ink-soft">{item.reason}</p>
              {item.tried && <p className="mt-0.5 text-xs text-lake-600">{item.tried}</p>}
              {item.place && (
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <a
                    href={`https://ditu.amap.com/search?query=${encodeURIComponent(item.place.name.slice(0, 40))}&city=${item.place.city ?? "330100"}`}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-xs text-ink-faint underline decoration-line-strong underline-offset-2 hover:text-lake-700"
                  >
                    在高德地图看看
                  </a>
                  <PlatformLinks name={item.place.name} />
                </div>
              )}
              {item.status === "pending" && message.open ? (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" className="h-8 px-3" onClick={() => void decide(item.index, "adopt")} disabled={busy !== null || !onDecide}>
                    {busy === item.index ? <LoaderCircle className="animate-spin" /> : null}
                    采纳
                  </Button>
                  <Button size="sm" variant="secondary" className="h-8 px-3" onClick={() => void decide(item.index, "dismiss")} disabled={busy !== null || !onDecide}>
                    忽略
                  </Button>
                </div>
              ) : (
                <p className="mt-1 text-xs text-ink-faint">
                  {item.status === "adopted" ? "已采纳" : item.status === "dismissed" ? "已忽略" : "这次生成已经过去了"}
                </p>
              )}
            </li>
          ))}
        </ul>
        {error && <p className="mt-1.5 text-xs text-sun-700">{error}</p>}
      </div>
      )}
    </Assistant>
  );
}

/**
 * V2.9：建议里推荐的地点，来自本轮的高德搜索。只显示名称；点开给出高德地图和点评平台的链接，
 * 链接里只带地点名（不带位置）。推荐不会自动加进卡片，说“就去这个”才加。
 */
function RecommendedPlaces({ places }: { places: readonly { readonly externalId: string; readonly name: string; readonly city?: string }[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = places.find((place) => place.externalId === open);
  return (
    <div className="mt-2 space-y-1.5">
      <ul className="flex flex-wrap gap-1.5">
        {places.map((place) => (
          <li key={place.externalId} className="min-w-0 max-w-full">
            <button
              type="button"
              onClick={() => setOpen(open === place.externalId ? null : place.externalId)}
              aria-expanded={open === place.externalId}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
                open === place.externalId
                  ? "border-lake-200 bg-lake-50 text-lake-700"
                  : "border-line bg-surface text-ink-soft hover:border-lake-200 hover:text-lake-700",
              )}
            >
              <MapPin className="size-3 shrink-0" />
              <span className="truncate">{place.name}</span>
              <ChevronDown className={cn("size-3 shrink-0 transition-transform", open === place.externalId && "rotate-180")} />
            </button>
          </li>
        ))}
      </ul>
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div
            key={shown.externalId}
            initial={{ opacity: 0, transform: "translateY(-2px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
            className="rounded-(--radius-field) border border-line bg-surface px-3 py-2"
          >
            <a
              href={`https://ditu.amap.com/search?query=${encodeURIComponent(shown.name.slice(0, 40))}&city=${shown.city ?? "330100"}`}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-xs text-ink-faint underline decoration-line-strong underline-offset-2 hover:text-lake-700"
            >
              在高德地图看看
            </a>
            <PlatformLinks name={shown.name} className="mt-1" />
            <p className="mt-1 text-xs text-ink-faint">想去的话跟我说“就去这个”，我帮你加进卡片。</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** 回答引用按站点与日期展示，用户可打开原页面核对来源。 */
function Sources({ sources }: { sources: readonly MessageSourceView[] }) {
  const web = sources.filter((source) => source.kind === "web");
  const passages = sources.filter((source) => source.kind === "kb");
  return (
    <>
      {web.length > 0 && <WebSources sources={web} />}
      {passages.length > 0 && <KnowledgeSources sources={passages} />}
    </>
  );
}

function WebSources({ sources }: { sources: readonly Extract<MessageSourceView, { kind: "web" }>[] }) {
  return (
    <div className="mt-2 space-y-1.5">
      <p className="flex items-center gap-1 text-xs text-ink-faint">
        <Globe className="size-3.5" />
        联网查到的信息，出发前以官方为准
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {sources.map((source) => (
          <li key={source.url} className="min-w-0 max-w-full">
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              title={source.title}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink-soft transition-colors hover:border-lake-200 hover:text-lake-700"
            >
              <span className="truncate">{source.site ?? new URL(source.url).hostname}</span>
              {source.date && <span className="shrink-0 text-ink-faint">· {source.date}</span>}
              <ExternalLink className="size-3 shrink-0" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

type PassageState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly passage: KnowledgePassageView }
  | { readonly status: "error" };

/** 自有资料库引用定位到文章章节，点击后展示对应段落正文。 */
function KnowledgeSources({ sources }: { sources: readonly Extract<MessageSourceView, { kind: "kb" }>[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [passages, setPassages] = useState<Record<string, PassageState>>({});
  async function toggle(chunkId: string) {
    if (open === chunkId) {
      setOpen(null);
      return;
    }
    setOpen(chunkId);
    if (passages[chunkId]?.status === "ready" || passages[chunkId]?.status === "loading") return;
    setPassages((current) => ({ ...current, [chunkId]: { status: "loading" } }));
    try {
      const response = await fetch(`/api/knowledge/${encodeURIComponent(chunkId)}`);
      const passage = response.ok ? await response.json() as KnowledgePassageView : null;
      setPassages((current) => ({ ...current, [chunkId]: passage ? { status: "ready", passage } : { status: "error" } }));
    } catch {
      setPassages((current) => ({ ...current, [chunkId]: { status: "error" } }));
    }
  }
  const shown = open ? passages[open] : undefined;
  return (
    <div className="mt-2 space-y-1.5">
      <p className="flex items-center gap-1 text-xs text-ink-faint">
        <BookOpen className="size-3.5" />
        来自资料库，点开看原文段落
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {sources.map((source) => {
          const section = source.headingPath.split(" > ").slice(1).join(" > ");
          return (
            <li key={source.chunkId} className="min-w-0 max-w-full">
              <button
                type="button"
                onClick={() => void toggle(source.chunkId)}
                aria-expanded={open === source.chunkId}
                title={source.headingPath}
                className={cn(
                  "inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
                  open === source.chunkId
                    ? "border-lake-200 bg-lake-50 text-lake-700"
                    : "border-line bg-surface text-ink-soft hover:border-lake-200 hover:text-lake-700",
                )}
              >
                <span className="shrink-0">资料库</span>
                <span className="truncate">· {source.title}{section ? ` · ${section}` : ""}</span>
                <ChevronDown className={cn("size-3 shrink-0 transition-transform", open === source.chunkId && "rotate-180")} />
              </button>
            </li>
          );
        })}
      </ul>
      <AnimatePresence initial={false}>
        {open && shown && (
          <motion.div
            key={open}
            initial={{ opacity: 0, transform: "translateY(-2px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
            className="rounded-(--radius-field) border border-line bg-surface px-3 py-2 text-[13px] leading-6 text-ink-soft"
          >
            {shown.status === "loading" && (
              <p className="flex items-center gap-1.5 text-xs text-ink-faint">
                <LoaderCircle className="size-3.5 animate-spin" />
                正在打开段落…
              </p>
            )}
            {shown.status === "error" && <p className="text-xs text-sun-700">这段原文现在打不开，可以稍后再试</p>}
            {shown.status === "ready" && (
              <>
                <p className="text-xs font-medium text-ink">{shown.passage.headingPath}</p>
                <p className="mt-1 whitespace-pre-wrap">{shown.passage.text}</p>
                {shown.passage.sources.length > 0 && (
                  <p className="mt-1.5 text-xs text-ink-faint">
                    本文依据：
                    {shown.passage.sources.map((source, index) => (
                      <span key={source.url}>
                        {index > 0 && "；"}
                        <a href={source.url} target="_blank" rel="noopener noreferrer nofollow" className="underline-offset-2 hover:text-lake-700 hover:underline">
                          {source.note}
                        </a>
                      </span>
                    ))}
                  </p>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Message({ message, actions }: { message: ChatMessageView; actions: MessageActions }) {
  switch (message.kind) {
    case "text":
      return message.role === "user" ? (
        <div className="flex justify-end">
          <p className="max-w-[85%] whitespace-pre-wrap rounded-[22px] rounded-br-md bg-lake-600 px-4 py-2.5 text-[15px] leading-6 text-white">
            {message.text}
          </p>
        </div>
      ) : (
        <Assistant>
          <p className="whitespace-pre-wrap text-[15px] leading-7">{message.text}</p>
          {message.places?.length ? <RecommendedPlaces places={message.places} /> : null}
          {message.sources?.length ? <Sources sources={message.sources} /> : null}
        </Assistant>
      );
    case "requirements_card":
      // 只有最新需求卡能编辑和启动规划，旧卡仅作历史记录。
      return (
        <Assistant wide>
          {message.latest ? (
            <RequirementsCard
              card={message.card}
              onChoosePlace={actions.onChoosePlace}
              onEdit={actions.onEdit}
              onUseLocation={actions.onUseLocation}
              locating={actions.locating}
              onStart={actions.onStart ? () => actions.onStart!(message.card) : undefined}
              starting={actions.starting}
              highlightStart={actions.highlightStart}
              onAllocate={actions.onAllocate}
              allocating={actions.allocating}
            />
          ) : (
            <SupersededCard card={message.card} />
          )}
        </Assistant>
      );
    case "planning_progress":
      return (
        <Assistant wide>
          <ProgressSteps steps={message.steps} running={message.running} onStop={actions.onStop} stopping={actions.stopping} />
        </Assistant>
      );
    case "plan_card":
      return (
        <Assistant wide>
          <PlanCard
            plan={message.plan}
            onSave={actions.onSave ? () => actions.onSave!(message.plan) : undefined}
            onReplan={actions.onReplan ? () => actions.onReplan!(message.plan) : undefined}
            saving={actions.savingRunId === message.plan.runId}
            conversationId={actions.conversationId ?? null}
          />
        </Assistant>
      );
    case "outing_day":
      return (
        <Assistant wide>
          <OutingDayCard
            view={message}
            onRedo={actions.onRedoDay ? () => actions.onRedoDay!(message) : undefined}
            busy={actions.starting}
          />
        </Assistant>
      );
    case "outing_change":
      return (
        <Assistant wide>
          <OutingChangeCard
            view={message}
            onConfirm={actions.onConfirmOutingChange ? () => actions.onConfirmOutingChange!(message) : undefined}
            confirming={actions.confirmingChange === message.changeId}
          />
        </Assistant>
      );
    case "choices":
      return (
        <Assistant wide>
          <ChoicesCard
            view={message}
            onPick={actions.onPick ? (option) => actions.onPick!(message, option) : undefined}
            onRefresh={actions.onRefresh ? () => actions.onRefresh!(message) : undefined}
            busy={actions.starting}
          />
        </Assistant>
      );
    case "adjust_card":
      return (
        <Assistant wide>
          <AdjustCard
            card={message}
            onConfirm={actions.onConfirmAdjust ? () => actions.onConfirmAdjust!(message) : undefined}
            confirming={actions.confirmingRunId === message.runId}
          />
        </Assistant>
      );
    case "preference_proposal":
      return <PreferenceProposal message={message} onDecide={actions.onPreference} />;
    case "outing_review":
      return <ReviewSuggestions message={message} onDecide={actions.onSuggestion} />;
    case "notice":
      return (
        <div
          className={cn(
            "mx-auto flex max-w-md items-start gap-2 rounded-(--radius-field) px-3.5 py-2 text-sm",
            message.tone === "warning" ? "bg-sun-50 text-sun-700" : "bg-sunken text-ink-soft",
          )}
        >
          {message.tone === "warning" ? <TriangleAlert className="mt-0.5 size-4 shrink-0" /> : <Info className="mt-0.5 size-4 shrink-0" />}
          <div className="min-w-0 space-y-2">
            <p>{message.text}</p>
            {/* V2.11：日常遇到外地时的“切到出游”，新卡片带上提到的外地地点。 */}
            {message.outing && (
              <button
                type="button"
                disabled={!actions.onSwitchToOuting}
                onClick={actions.onSwitchToOuting}
                className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-lake-700 hover:bg-lake-50 disabled:text-ink-faint"
              >
                切到出游
              </button>
            )}
          </div>
        </div>
      );
  }
}

function Assistant({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex gap-3">
      <span
        className={cn(
          "mt-1 size-7 shrink-0 place-items-center rounded-full bg-ink text-[11px] font-bold text-white",
          // 手机上宽卡片优先占满可用宽度，较宽屏幕再保留头像，避免挤压正文。
          wide ? "hidden sm:grid" : "grid",
        )}
      >
        TQ
      </span>
      <div className={cn("min-w-0", wide ? "flex-1" : "max-w-[85%]")}>{children}</div>
    </div>
  );
}
