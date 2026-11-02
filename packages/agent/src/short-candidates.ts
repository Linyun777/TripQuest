import { z } from "zod";
import { chinaDate, parseOpenToday } from "@tripquest/application/opening-hours";
import { chooseLeg, straightMeters } from "@tripquest/application/leg-choice";
import { planningPlaceSchema, type PlanningPlace, type TravelPreference } from "@tripquest/application/planning";
import type { DayRoute } from "@tripquest/domain";
import type { MobilityProvider, PlaceBusiness, PlaceSummary } from "@tripquest/providers";
import type { ModelReply } from "./contracts";
import { dayOperation } from "./day-runtime";
import { partOf } from "./place-names";
import { inAgent } from "./agents/run-agent";

/**
 * 短途只处理一步：围绕起点或刚选中的上一站找候选，模型负责搜索词、筛选和理由。
 * 服务端负责真实搜索、去重和路线；模型调用失败时用最近候选兜底，供应商失败与无合适地点分别返回。
 */
export const SHORT_LIMITS = {
  queries: 2, perQuery: 5, pool: 10, offerMin: 3, offerMax: 5,
  repairs: 1, modelMs: 15_000, providerMs: 5_000, radii: [3000, 10_000, 30_000],
} as const;

export interface CandidateContext {
  readonly protocolVersion: "short-candidates.v1";
  readonly stage: "queries" | "picks";
  readonly interest: { readonly text: string; readonly when?: string };
  /** 搜索中心只取本步起点或上一站，防止后续兴趣仍围绕最初出发地检索。 */
  readonly anchor: { readonly name: string; readonly isStart: boolean };
  /** 筛选阶段提供服务端实际查到的候选，按直线距离从近到远排列。 */
  readonly found?: readonly {
    readonly id: string;
    readonly name: string;
    readonly meters: number;
    readonly keytag?: string;
    readonly rating?: number;
    readonly costYuan?: number;
  }[];
  readonly wet?: boolean;
  /** 上一答的结构或语义问题；最多反馈一次，失败后交确定性兜底。 */
  readonly feedback: string | null;
}

export interface CandidateDecisionModel {
  readonly mode: "scripted" | "live";
  readonly provider: string;
  readonly model: string;
  decide(context: CandidateContext, options: { signal: AbortSignal }): Promise<ModelReply>;
}

const queriesSchema = z.strictObject({
  queries: z.array(z.string().trim().min(2).max(20)).min(1).max(SHORT_LIMITS.queries),
});
const picksSchema = z.strictObject({
  picks: z.array(z.strictObject({
    id: z.string().regex(/^c\d{1,2}$/),
    reason: z.string().trim().min(1).max(300),
    stayMinutes: z.number().int().min(15).max(180),
  })).max(SHORT_LIMITS.offerMax),
});

/** 挑选阶段的输入：兴趣、搜索中心和服务端查到的候选（按直线距离从近到远）。 */
export type PickContext = Pick<CandidateContext, "interest" | "anchor" | "wet"> & { readonly found: NonNullable<CandidateContext["found"]> };
/** 挑选结果：空 picks 表示判断本批都不合适；null 表示没能完成（交下一种做法或距离兜底）。 */
export type PickAnswer = z.infer<typeof picksSchema>;

/** 有界调用模型：schema 检查结构，check 检查语义，最多修一次；模型故障返回 null。 */
async function askModel<T>(
  model: CandidateDecisionModel,
  context: Omit<CandidateContext, "feedback">,
  schema: z.ZodType<T>,
  check: (value: T) => string | null,
  signal: AbortSignal,
): Promise<{ value: T | null; requests: number }> {
  let feedback: string | null = null;
  let requests = 0;
  for (let attempt = 0; attempt <= SHORT_LIMITS.repairs; attempt += 1) {
    requests += 1;
    try {
      const reply = await dayOperation({
        signal,
        timeoutMs: SHORT_LIMITS.modelMs,
        operation: (inner) => model.decide({ ...context, feedback }, { signal: inner }),
      });
      const parsed = schema.safeParse(reply.decision);
      feedback = parsed.success ? check(parsed.data) : `invalid_shape: ${parsed.error.issues[0]?.path.join(".") || "answer"}`;
      if (parsed.success && !feedback) return { value: parsed.data, requests };
    } catch {
      if (signal.aborted) throw new Error("timeout");
      return { value: null, requests }; // 模型故障或额度不足交调用方兜底；主动取消不能被当成普通失败继续搜索。
    }
  }
  return { value: null, requests };
}

/**
 * V2.9.2：挑选这一步单独成函数，评测可以拿固定候选直接对照（DeepSeek 与 Jev）。
 * 模型只能从已查候选中挑并写理由；编号只覆盖本批，不能重复。V2.9.3：挑 1–5 个都接受，不再要求至少 3 个
 * （提示词让模型“合适的不够就少挑”，代码却打回，修一次仍少就退到距离兜底，给的恰好是最近的不合适的）。
 */
export async function pickWithModel(
  model: CandidateDecisionModel,
  context: PickContext,
  signal: AbortSignal,
): Promise<{ answer: PickAnswer | null; requests: number }> {
  const ids = context.found.map((item) => item.id);
  // 字段顺序与 V2.4 起发给模型的一致（提示缓存按前缀命中）。
  const request = {
    protocolVersion: "short-candidates.v1" as const,
    interest: context.interest,
    anchor: context.anchor,
    ...(context.wet ? { wet: true } : {}),
    stage: "picks" as const,
    found: context.found,
  };
  const { value, requests } = await askModel(model, request, picksSchema, (answer) => {
    if (!answer.picks.length) return null; // 合法空选择表示模型判断本批都不合适；接受为 none，不用距离兜底强推一个。
    const chosen = answer.picks.map((pick) => pick.id);
    if (chosen.some((id) => !ids.includes(id))) return `unknown_id: use only ${ids.join(",")}`;
    if (new Set(chosen).size !== chosen.length) return "duplicate_id: each place once";
    return null;
  }, signal);
  return { answer: value, requests };
}

/**
 * V2.9.2：可替换的挑选实现（Jev）。返回 null 表示没能完成，交给模型挑选，再不行按距离兜底；
 * 空 picks 表示判断本批都不合适。failure、model、inputTokens 只用于决策记录和评测报告。
 */
export interface CandidatePicker {
  readonly name: string;
  pick(context: PickContext, signal: AbortSignal): Promise<{
    readonly answer: PickAnswer | null;
    readonly failure?: string;
    readonly model?: string;
    readonly inputTokens?: number;
  }>;
}

export interface Candidate {
  readonly selection: PlanningPlace;
  /** 评分、价格等仅随本次响应展示，不写入候选消息或正式行程。 */
  readonly business?: PlaceBusiness;
  readonly reason: string;
  readonly stayMinutes: number;
  /** 相对本步中心的直线距离，用于排序与展示，不代表可步行距离。 */
  readonly meters: number;
  /** 从搜索中心到候选的实际路线查询结果；具体方式沿用一日规划的选路策略。 */
  readonly route: DayRoute;
  readonly path?: readonly (readonly [number, number])[];
}

export type CandidateResult =
  | { readonly status: "ok"; readonly candidates: readonly Candidate[]; readonly fallback: boolean; readonly counts: CandidateCounts }
  /** 查询成功但没有合适候选是正常业务结果，不能与网络或供应商故障混为一谈。 */
  | { readonly status: "none"; readonly counts: CandidateCounts }
  | { readonly status: "failed"; readonly code: "provider_error" | "timeout"; readonly counts: CandidateCounts };
export interface CandidateCounts { model: number; searches: number; routes: number }

export interface CandidateStep {
  readonly interest: { readonly text: string; readonly when?: string };
  readonly anchor: PlanningPlace;
  readonly anchorIsStart: boolean;
  /** 本轮已展示、已选择的地点编号：换一批时排除旧候选，下一步排除已去站。 */
  readonly exclude: readonly string[];
  readonly travel: TravelPreference;
  /** 本步预计出发时刻，提供给路线与当天营业预筛；不是已发生事实。 */
  readonly departureAt: string;
  readonly wet?: boolean;
  /** V2.11：日常只在这个城市里找（D-072）；扩大半径后搜到的邻市地点不给。 */
  readonly cityAdcode?: string;
}

export function createCandidateRunner(dependencies: {
  provider: MobilityProvider;
  model: CandidateDecisionModel;
  /** V2.9.2：先用它挑（Jev）；没能完成时照旧由模型挑。 */
  picker?: CandidatePicker;
}) {
  // V3.0：入口建挑地点的子运行；输入（PickContext）只有类型，交接只记录。
  function run(step: CandidateStep, options: { signal: AbortSignal }): Promise<CandidateResult> {
    return inAgent(
      "short-picker",
      { input: step },
      async (agentRun) => {
        const result = await pick(step, options);
        if (result.status === "ok" && result.fallback) agentRun?.step("fallback", "nearby", {});
        agentRun?.step("check", "result", { ...result.counts, ...(result.status === "ok" ? { offered: result.candidates.length } : {}) });
        return result;
      },
      (result) => result.status === "ok"
        ? { status: result.fallback ? "fallback" : "ok" }
        : result.status === "none" ? { status: "none" } : { status: "failed", outcome: result.code },
    );
  }

  async function pick(step: CandidateStep, options: { signal: AbortSignal }): Promise<CandidateResult> {
    const counts: CandidateCounts = { model: 0, searches: 0, routes: 0 };

    const interest = { text: step.interest.text, ...(step.interest.when ? { when: step.interest.when } : {}) };
    const anchor = { name: step.anchor.place.name, isStart: step.anchorIsStart };
    const base = { protocolVersion: "short-candidates.v1" as const, interest, anchor, ...(step.wet ? { wet: true } : {}) };
    try {
      // 先请模型写搜索词；模型无法产出合法词时使用用户原话，仍只在同一个搜索中心查找。
      const asked = await askModel(dependencies.model, { ...base, stage: "queries" }, queriesSchema, () => null, options.signal);
      counts.model += asked.requests;
      const queries = [...new Set(asked.value?.queries ?? [step.interest.text.slice(0, 20)])];

      // 服务端执行周边搜索并按真实地点去重，过滤已选站、子节点重复和明确快关门的候选。
      const pool: { place: PlaceSummary; evidence: PlanningPlace["evidence"]; meters: number }[] = [];
      let answered = 0;
      // V2.10：郊区、山脚附近的店少：3 公里内不到 3 个就扩到 10 公里，再不到就扩到 30 公里；
      // 候选带着距离给模型，不会把 8 公里外说成“附近”。
      for (const radiusMeters of SHORT_LIMITS.radii) {
        if (pool.length >= 3) break;
        for (const query of queries) {
          counts.searches += 1;
          const reply = await dayOperation({
            signal: options.signal,
            timeoutMs: SHORT_LIMITS.providerMs,
            operation: (signal) => dependencies.provider.searchPlaces({
              query,
              scope: { kind: "nearby", center: step.anchor.place.location, radiusMeters },
              limit: SHORT_LIMITS.perQuery,
              withBusiness: true,
            }, { signal }),
          }).catch(() => null);
          if (!reply || reply.status !== "ok") continue;
          answered += 1;
          for (const place of reply.data.items) {
            const known = pool.some((item) => item.place.ref.externalId === place.ref.externalId ||
              partOf(place.name, item.place.name) || partOf(item.place.name, place.name));
            if (known || step.exclude.includes(place.ref.externalId) || place.ref.externalId === step.anchor.place.ref.externalId) continue;
            if (closedBy(place, reply.evidence.retrievedAt, step.departureAt)) continue;
            if (step.cityAdcode && place.cityAdcode && place.cityAdcode !== step.cityAdcode) continue;
            pool.push({ place, evidence: reply.evidence, meters: Math.round(straightMeters(step.anchor.place.location, place.location)) });
          }
        }
        if (!answered) break;
      }
      // 至少一个搜索成功才有资格说“附近没有”；全部请求失败只能说明暂时查不到。
      if (!answered) return { status: "failed", code: "provider_error", counts };
      pool.sort((a, b) => a.meters - b.meters);
      const found = pool.slice(0, SHORT_LIMITS.pool);
      if (!found.length) return { status: "none", counts };

      // 模型只能从已查候选中挑选并写理由；无效输出修复耗尽后按距离取前几个。
      // c 编号仅覆盖本批真实候选，模型不能扩充地点池；推荐不足时也不能复制同一家凑数量。
      const ids = found.map((_, index) => `c${index + 1}`);
      const least = Math.min(SHORT_LIMITS.offerMin, found.length);
      const pickContext: PickContext = {
        interest,
        anchor,
        ...(step.wet ? { wet: true } : {}),
        found: found.map((item, index) => ({
          id: ids[index], name: item.place.name, meters: item.meters,
          ...(item.place.business?.keytag ? { keytag: item.place.business.keytag } : {}),
          ...(item.place.business?.rating ? { rating: item.place.business.rating } : {}),
          ...(item.place.business?.costYuan ? { costYuan: item.place.business.costYuan } : {}),
        })),
      };
      const first = dependencies.picker ? await dependencies.picker.pick(pickContext, options.signal).catch(() => ({ answer: null })) : null;
      if (options.signal.aborted) throw new Error("timeout");
      const chosen = first?.answer ? { answer: first.answer, requests: 0 } : await pickWithModel(dependencies.model, pickContext, options.signal);
      counts.model += chosen.requests;
      const picked = chosen.answer;
      if (picked && !picked.picks.length) return { status: "none", counts };
      const near = step.anchorIsStart ? "离你最近" : "离上一站最近";
      // 确定性兜底只在模型调用/格式失败时启用，沿用同一份已经查到的候选池，原因明确标为离得近。
      const offers = picked
        ? picked.picks.map((pick) => ({ item: found[ids.indexOf(pick.id)], reason: cleanReason(pick.reason), stayMinutes: pick.stayMinutes }))
        : found.slice(0, least).map((item) => ({ item, reason: near, stayMinutes: 60 }));

      // 为每个推荐候选查询从本步中心出发的路线；查不到的路线保留 unknown，不能用直线距离补造时长。
      const candidates: Candidate[] = [];
      for (const offer of offers) {
        // 规划选择只携带当天营业窗口；评分、价格等详情留在本次展示对象，避免随需求长期保存。
        const { business } = offer.item.place;
        const selection = planningPlaceSchema.parse({ place: offer.item.place, evidence: offer.item.evidence });
        const chosen = await chooseLeg({
          from: { placeId: "anchor", place: step.anchor.place },
          to: { placeId: "candidate", place: selection.place },
          travel: step.travel,
          provider: dependencies.provider,
          departureAt: step.departureAt,
          call: { signal: options.signal },
        });
        counts.routes += chosen.requests;
        candidates.push({
          selection, reason: offer.reason, stayMinutes: offer.stayMinutes, meters: offer.item.meters, route: chosen.route,
          ...(business ? { business } : {}), ...(chosen.path ? { path: chosen.path } : {}),
        });
      }
      return { status: "ok", candidates, fallback: !picked, counts };
    } catch {
      if (options.signal.aborted) return { status: "failed", code: "timeout", counts };
      return { status: "failed", code: "provider_error", counts };
    }
  }
  return { run };
}

/** 理由文案清理函数只规范展示文本，不参与候选可行性判断。 */
/**
 * 营业预筛要求出发后至少还开放 45 分钟：粗略留 15 分钟抵达和 30 分钟停留。
 * 这是早期筛选启发式，不替代最终排程；曾用 30 分钟仍会推荐马上关门的店。
 */
const OPEN_AFTER_DEPARTURE = 45;

/** 只用查询当天且可解析的营业信息排除明显无时间访问的地点；未知营业时间不当作关闭。 */
function closedBy(place: PlaceSummary, retrievedAt: string, departureAt: string): boolean {
  const windows = place.business?.openToday ? parseOpenToday(place.business.openToday) : null;
  if (!windows || chinaDate(retrievedAt) !== departureAt.slice(0, 10)) return false;
  const departs = Number(departureAt.slice(11, 13)) * 60 + Number(departureAt.slice(14, 16));
  return !windows.some((window) => window.endsAt >= departs + OPEN_AFTER_DEPARTURE);
}

function cleanReason(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || "符合你的要求";
}
