import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { BaselinePlanningInput, BaselinePlanningResult } from "@tripquest/domain";
import { runAgent, type AgentDependencies } from "./graph";
import type { AgentResult } from "./contracts";

export function snapshotFingerprint(input: BaselinePlanningInput): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(normalize(input))).digest("hex");
}

export interface LocationQuestion {
  readonly sessionId: string;
  readonly questionId: string;
  readonly planVersion: number;
  readonly stateVersion: number;
  readonly snapshotFingerprint: string;
  readonly field: "current_location";
  readonly text: string;
  readonly options: readonly { id: string; name: string }[];
}
export interface InvestigationSnapshot {
  readonly sessionId: string;
  readonly status: "awaiting_user" | "finished" | "cancelled";
  readonly question: LocationQuestion | null;
  readonly initial: BaselinePlanningInput;
  readonly initialResult: BaselinePlanningResult;
  readonly initialFingerprint: string;
  readonly followup: BaselinePlanningInput | null;
  readonly followupFingerprint: string | null;
  readonly answer: {
    readonly choice: string;
    readonly provenance: "user_answer";
    readonly parentSessionId: string;
    readonly oldStateVersion: number;
    readonly newStateVersion: number;
  } | null;
  readonly output: AgentResult | null;
  readonly planningCalls: number;
  readonly waitingMs: number;
  readonly executionMs: number;
}
const answerSchema = z.object({
  questionId: z.string(),
  snapshotFingerprint: z.string(),
  choice: z.string(),
}).strict();

function canAsk(input: BaselinePlanningInput, result: BaselinePlanningResult): boolean {
  if (result.status !== "needs_information" ||
      !result.issues.some((issue) => issue.code === "unknown_location")) return false;
  const { state, plan, request } = input;
  if (state.location.kind !== "unknown" || state.currentActivityId !== null ||
      !Number.isSafeInteger(state.version + 1) ||
      input.reservations.some((item) => item.confirmation.status !== "confirmed")) return false;
  const finished = new Set([...state.completedActivityIds, ...state.skippedActivityIds]);
  const remaining = plan.activities.filter((activity) => !finished.has(activity.id));
  if (remaining.length !== 2) return false;
  const [target, reservation] = remaining;
  const start = request.scope.kind === "selected_window"
    ? request.scope.window.startsAt : request.scope.from;
  const end = request.scope.kind === "selected_window"
    ? request.scope.window.endsAt : `${plan.date}T23:59:59+08:00`;
  return !target.locked && !target.reservationId && reservation.locked &&
    !!reservation.reservationId &&
    remaining.every((activity) => Date.parse(activity.startsAt) >= Date.parse(state.observedAt)) &&
    Date.parse(target.startsAt) >= Date.parse(start) && Date.parse(target.endsAt) <= Date.parse(end);
}

/** 调用方持有的内存澄清会话，不是暂停中的持久图；不创建全局注册表、定时任务或数据库记录。 */
export function createInvestigation(source: BaselinePlanningInput, dependencies: AgentDependencies & {
  readonly places: readonly { id: string; name: string }[];
}) {
  const initial = structuredClone(source);
  const initialResult = dependencies.plan(structuredClone(initial));
  const sessionId = randomUUID();
  const fingerprint = snapshotFingerprint(initial);
  const eligible = canAsk(initial, initialResult);
  const options = (eligible ? initial.plan.activities : []).flatMap((activity) => {
    const place = dependencies.places.find((entry) => entry.id === activity.placeId);
    return place ? [{ id: place.id, name: place.name }] : [];
  }).filter((place, index, all) => all.findIndex((entry) => entry.id === place.id) === index);
  const question: LocationQuestion | null = options.length > 0 && eligible ? {
    sessionId,
    questionId: randomUUID(),
    planVersion: initial.plan.version,
    stateVersion: initial.state.version,
    snapshotFingerprint: fingerprint,
    field: "current_location",
    text: "在本次观察时间，你位于以下哪个地点？",
    options: [...options, { id: "cannot_answer", name: "均不在/不确定" }],
  } : null;
  let consumed = false;
  let started = false;
  const controller = new AbortController();
  const createdAt = performance.now();
  let snapshot: InvestigationSnapshot = {
    sessionId,
    status: dependencies.signal?.aborted ? "cancelled" : question ? "awaiting_user" : "finished",
    question,
    initial,
    initialResult,
    initialFingerprint: fingerprint,
    followup: null,
    followupFingerprint: null,
    answer: null,
    output: null,
    planningCalls: 1,
    waitingMs: 0,
    executionMs: 0,
  };
  const view = () => structuredClone(snapshot);
  async function execute(input: BaselinePlanningInput, reuseInitial: boolean) {
    const begin = performance.now();
    let first = reuseInitial;
    const output = await runAgent(input, {
      ...dependencies,
      signal: AbortSignal.any([controller.signal, ...(dependencies.signal ? [dependencies.signal] : [])]),
      plan(value) {
        if (first) {
          first = false;
          return structuredClone(initialResult);
        }
        snapshot = { ...snapshot, planningCalls: snapshot.planningCalls + 1 };
        return dependencies.plan(value);
      },
    });
    snapshot = {
      ...snapshot,
      status: controller.signal.aborted || dependencies.signal?.aborted ? "cancelled" : "finished",
      output,
      executionMs: performance.now() - begin,
    };
    return view();
  }
  return {
    snapshot: view,
    async start() {
      if (started || consumed) throw new Error("session_consumed");
      started = true;
      if (question || snapshot.status === "cancelled") return view();
      consumed = true;
      return execute(initial, true);
    },
    async answer(value: unknown, currentInput: BaselinePlanningInput) {
      if (consumed || snapshot.status !== "awaiting_user") throw new Error("question_consumed");
      if (dependencies.signal?.aborted) {
        consumed = true;
        snapshot = { ...snapshot, status: "cancelled" };
        throw new Error("session_cancelled");
      }
      // 版本号相同也可能出现内容变化，所以比完整快照指纹；旧问题的答案不能套用到另一份输入。
      if (snapshotFingerprint(currentInput) !== fingerprint) {
        consumed = true;
        snapshot = { ...snapshot, status: "cancelled" };
        throw new Error("stale_snapshot");
      }
      const parsed = answerSchema.safeParse(value);
      if (!parsed.success || parsed.data.questionId !== question?.questionId ||
          parsed.data.snapshotFingerprint !== fingerprint ||
          !question.options.some((option) => option.id === parsed.data.choice)) {
        throw new Error("invalid_answer");
      }
      // 在任何 await 之前消费回答资格；同一进程并发回答只能有一个进入后续执行。
      consumed = true;
      const choice = parsed.data.choice;
      const waitingMs = performance.now() - createdAt;
      // 用户不确定是合法结束，不自动猜位置或追加工具调查；记录信息仍未补齐，不制造新的状态版本。
      if (choice === "cannot_answer") {
        snapshot = {
          ...snapshot,
          status: "finished",
          waitingMs,
          answer: {
            choice, provenance: "user_answer", parentSessionId: sessionId,
            oldStateVersion: initial.state.version, newStateVersion: initial.state.version,
          },
        };
        return view();
      }
      // 用户回答带来了新事实，创建新的状态版本与请求，而不是修改原调查快照。
      // provenance 标记信息来自用户，评测时不能把补充位置带来的收益算成模型推断能力。
      const followup: BaselinePlanningInput = {
        ...structuredClone(initial),
        state: {
          ...structuredClone(initial.state),
          version: initial.state.version + 1,
          location: { kind: "known", placeId: choice },
        },
        request: {
          ...structuredClone(initial.request),
          id: randomUUID(),
          baseStateVersion: initial.state.version + 1,
        },
      };
      snapshot = {
        ...snapshot,
        waitingMs,
        followup,
        followupFingerprint: snapshotFingerprint(followup),
        answer: {
          choice, provenance: "user_answer", parentSessionId: sessionId,
          oldStateVersion: initial.state.version, newStateVersion: followup.state.version,
        },
      };
      return execute(followup, false);
    },
    cancel() {
      consumed = true;
      controller.abort();
      snapshot = { ...snapshot, status: "cancelled", waitingMs: performance.now() - createdAt };
      return view();
    },
  };
}
