import { execFileSync } from "node:child_process";
import { agentRows, evalCase, repairTraces } from "./agent-summary";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTAKE_CASES, INTAKE_DATASET_VERSION, intakeDatasetDigest } from "./v21/intake-dataset";
import {
  INTENT_DATASET_VERSION,
  INTENT_INTAKE_CASES,
  INTENT_PLAN_CASES,
  intentDatasetDigest,
} from "./v21/intent-dataset";
import { ALL_PLAN_CASES, PLAN_DATASET_VERSION, planDatasetDigest, walkingOnly } from "./v21/plan-dataset";
import { SHORT_DATASET_VERSION, SHORT_INTAKE_CASES, SHORT_PLAN_CASES, shortDatasetDigest } from "./v21/short-dataset";
import { runShortAsDay, runShortFlow, type ShortRow } from "./v21/short-run";
import { ADJUST_DATASET_VERSION, ADJUST_INTAKE_CASES, ADJUST_PLAN_CASES, adjustDatasetDigest } from "./v21/adjust-dataset";
import { runAdjustAsDay, runAdjustFlow, runAdjustIntake, type AdjustIntakeRow, type AdjustRow } from "./v21/adjust-run";
import { INFO_CASES, INFO_DATASET_VERSION, INFO_WEB, infoDatasetDigest } from "./v21/info-dataset";
import { runInfoCase, type InfoRow } from "./v21/info-run";
import { NOTES_CASES, NOTES_DATASET_VERSION, notesDatasetDigest } from "./v21/notes-dataset";
import { runNotesCase, type NotesRow } from "./v21/notes-run";
import { KNOWLEDGE_CASES, KNOWLEDGE_DATASET_VERSION, knowledgeDatasetDigest } from "./v21/knowledge-dataset";
import { runKnowledgeCase, type KnowledgeFlow, type KnowledgeRow } from "./v21/knowledge-run";
import { ROUTE_CASES, ROUTE_DATASET_VERSION, routeDatasetDigest } from "./v29/route-dataset";
import { currentProductRouter, fromIntentRouter, runRouteCase, type EvalRouter, type RouteRow } from "./v29/route-run";
import { createRegexCascadeRouter, regexRouter } from "@tripquest/agent/intent";
import { createEmbeddingIntentRouter, DEFAULT_CASCADE_ROUTER, DEFAULT_EMBEDDING_ROUTER, INTENT_EXEMPLARS_VERSION } from "@tripquest/agent/intent-embedding";
import { DashScopeEmbeddingProvider } from "@tripquest/providers/server";
import { tuneEmbeddingRouter } from "./v29/route-tune";
import { runConversationRow, type ConversationCase, type ConversationRow } from "./v29/conversation-run";
import { TALK_CASES, TALK_DATASET_VERSION, talkDatasetDigest } from "./v29/talk-dataset";
import { PREF_CASES, PREF_DATASET_VERSION, prefDatasetDigest } from "./v29/pref-dataset";
import { LONG_CASES, LONG_DATASET_VERSION, longDatasetDigest } from "./v29/long-dataset";
import { FIX_CASES, FIX_DATASET_VERSION, fixDatasetDigest } from "./v29/fix-dataset";
import { createJevClient } from "@tripquest/agent/jev";
import { jevIntentRouter } from "@tripquest/agent/intent-jev";
import { createJevPicker } from "@tripquest/agent/short-jev";
import { V292_ROUTE_CASES, V292_ROUTE_DATASET_VERSION, v292RouteDigest } from "./v292/route-holdout";
import { PICK_CASES, PICKS_DATASET_VERSION, picksDatasetDigest } from "./v292/picks-dataset";
import { deepSeekPicker, jevPicker, runPickCase, type EvalPicker, type PickRow } from "./v292/picks-run";
import { ROUTE_E2E_CASES, ROUTE_E2E_VERSION, routeE2eDigest } from "./v293/route-e2e";
import { setEvalChatRouter } from "./v293/chat-router";
import { CITY_CASES, CITY_DATASET_VERSION, cityDatasetDigest, KB_CITY_CASES } from "./v210/city-dataset";
import { DAILY_CITY_CASES, DAILY_CITY_DATASET_VERSION, dailyCityDatasetDigest } from "./v211/daily-city-dataset";
import { STAY_CHAT_CASES, STAY_DATASET_VERSION, STAY_PLAN_CASES, stayDatasetDigest } from "./v211/stay-dataset";
import { OUTING_INTAKE_CASES, OUTING_INTAKE_VERSION, outingIntakeDigest } from "./v211/outing-intake-dataset";
import { runTransferCase, type TransferRow } from "./v211/transfer-run";
import { runAllocationCase, type AllocationRow } from "./v211/allocation-run";
import { runOutingCase, type OutingRow } from "./v211/outing-run";
import { runCrossDayCase, type CrossDayRow } from "./v211/cross-day-run";
import { REVIEW_CASES, REVIEW_DATASET_VERSION, reviewDatasetDigest } from "./v32/review-dataset";
import { runReviewCase, type ReviewRow } from "./v32/review-run";
import { LODGING_CASES, LODGING_DATASET_VERSION, lodgingDatasetDigest } from "./v33/lodging-dataset";
import { runLodgingCase, type LodgingRow } from "./v33/lodging-run";
import { RELIABILITY_CASES, RELIABILITY_DATASET_VERSION, reliabilityDatasetDigest } from "./v42/reliability-dataset";
import { runReliabilityCase, type ReliabilityRow } from "./v42/reliability-run";
import { SPLIT_CHAT_CASES, SPLIT_DATASET_VERSION, SPLIT_OUTING_CASES, splitDatasetDigest } from "./v34/split-dataset";
import { runSplitOutingCase, type SplitOutingRow } from "./v34/split-run";
import { RIDES_CASES, RIDES_VERSION, ridesDigest } from "./v36/rides-dataset";
import { fillRidesAfterTurn } from "./v36/rides-run";
import { STAYS_CASES, STAYS_DATASET_VERSION, staysDigest } from "./v43/stays-dataset";
import { staysAfterTurn } from "./v43/stays-run";
import { DATES_CASES, DATES_DATASET_VERSION, datesDigest } from "./v44/dates-dataset";
import { datesAfterTurn } from "./v44/dates-run";
import { JUDGE_CASES, JUDGE_DATASET_VERSION, judgeDigest } from "./v47/judge-dataset";
import { runJudgeCase, type JudgeRow } from "./v47/judge-run";
import { REPAIR_CASES, REPAIR_DATASET_VERSION, repairDigest } from "./v47/repair-dataset";
import { runRepairCase, type RepairRow } from "./v47/repair-run";
import { DATES45_CASES, DATES45_DATASET_VERSION, dates45Digest } from "./v45/dates-dataset";
import { ACCEPT_ALLOCATION_CASES, ACCEPT_CHAT_CASES, ACCEPT_FIX_VERSION, ACCEPT_OUTING_CASES, acceptFixDigest } from "./v211/acceptance-fix-dataset";
import { OUTING_PLAN_VERSION, outingPlanDigest, TRANSFER_DAY_CASES, ALLOCATION_CASES, OUTING_E2E_CASES, CROSS_DAY_CASES } from "./v211/outing-plan-dataset";
import { PLAY_CASES, PLAY_DATASET_VERSION, playDatasetDigest } from "./v210/play-dataset";
import { runPlayCase, type PlayRow } from "./v210/play-run";
import { YUNLING_SHORT_CASES, YUNLING_SHORT_VERSION, yunlingShortDigest } from "./v210/short-dataset";
import { v21ModelBudget } from "./v21/budget";
import { renderV21, type V21Report } from "./v21/report";
import { runIntakeCase, runPlanCase, type IntakeRow, type PlanRow } from "./v21/run";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const outputRoot = join(root, "eval-results");
/** One live evaluation run may spend at most this many requests of the daily 200. */
const RUN_LIMIT = 150;

function git(): V21Report["git"] {
  try {
    return {
      sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      dirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    };
  } catch {
    return { sha: "unavailable", dirty: null };
  }
}

type Suite = "plan" | "intake" | "intent" | "short" | "adjust" | "info" | "notes" | "knowledge" | "route" | "route-tune" | "talk" | "pref" | "long" | "fix" | "picks" | "e2e" | "city" | "kbcity" | "play" | "shortcity" | "daily" | "stay" | "outing" | "transfer" | "allocation" | "trip" | "crossday" | "accept" | "review" | "lodging" | "split" | "rides" | "reliability" | "stays" | "dates" | "dates45" | "judge" | "repair" | "all";
/** V2.9 suites run only when named (not in "all"). */
const V29_SUITES: readonly Suite[] = ["route", "route-tune", "talk", "pref", "long", "fix", "picks", "e2e", "city", "kbcity", "play", "shortcity", "daily", "stay", "outing", "transfer", "allocation", "trip", "crossday", "accept", "review", "lodging", "split", "rides", "reliability", "stays", "dates", "dates45", "judge", "repair"];
interface Options {
  readonly live: boolean;
  readonly suite: Suite;
  readonly cases: ReadonlySet<string> | null;
  /** Live runs of each case; the model is not deterministic, so V2.3 reads pass rates. */
  readonly repeat: number;
  /** V2.3 held-out cases join only at the end of the stage. */
  readonly heldOut: boolean;
  /** V2.9.2：`--held-out v292` 只跑分流的新留出题（锁定后每种实现跑一次正式结果）。 */
  readonly newHoldout: boolean;
  /** V2.9.3：对话 Agent 用哪种分流（缺省正则，与产品相同）。 */
  readonly router: "regex" | "deepseek" | "regex+deepseek";
  /** V2.4 short cases: "short" is the new flow; "day" is the old day planner (the baseline). */
  readonly flow: "day" | "short" | "adjust" | "per_stop" | KnowledgeFlow | "current" | "regex" | "deepseek" | "embedding" | "cascade" | "summary" | "jev" | "jev13" | "no_fill" | "regex+deepseek" | null;
}

const USAGE = "Usage: --policy scripted|live [--suite plan|intake|intent|short|adjust|info|notes|knowledge|route|route-tune|talk|pref|long|fix|picks|e2e|city|kbcity|play|shortcity|daily|stay|outing|transfer|allocation|trip|crossday|accept|review|lodging|split|rides|reliability|stays|dates|dates45|judge|repair|all] [--router regex|deepseek|regex+deepseek] [--case P10,I03] [--repeat 1-3] [--held-out yes|v292] [--flow day|short|adjust|per_stop|kb|web_only|no_tools|current|regex|deepseek|embedding|cascade|summary|jev|jev13|no_fill|regex+deepseek] (default: the suite's new flow)";

/**
 * --policy scripted|live, --suite plan|intake|intent|all (intent: the V2.3 cases only),
 * --case P10,I03, --repeat 1-3, --held-out yes (defaults: scripted, all, every case, 1, no).
 */
function parse(argv: readonly string[]): Options {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (!["--policy", "--suite", "--case", "--repeat", "--held-out", "--flow", "--router"].includes(flag) || !value || values.has(flag)) {
      throw new Error(USAGE);
    }
    values.set(flag, value);
  }
  const policy = values.get("--policy") ?? "scripted";
  const suite = values.get("--suite") ?? "all";
  const repeat = Number(values.get("--repeat") ?? "1");
  const heldOut = values.get("--held-out");
  const flow = values.get("--flow") ?? null;
  const suites = ["plan", "intake", "intent", "short", "adjust", "info", "notes", "knowledge", "route", "route-tune", "talk", "pref", "long", "fix", "picks", "e2e", "city", "kbcity", "play", "shortcity", "daily", "stay", "outing", "transfer", "allocation", "trip", "crossday", "accept", "review", "lodging", "split", "rides", "reliability", "stays", "dates", "dates45", "judge", "repair", "all"];
  const flows = ["day", "short", "adjust", "per_stop", "kb", "web_only", "no_tools", "current", "regex", "deepseek", "embedding", "cascade", "summary", "jev", "jev13", "no_fill", "regex+deepseek"];
  if (!["scripted", "live"].includes(policy) || !suites.includes(suite) ||
    ![1, 2, 3].includes(repeat) || (heldOut !== undefined && heldOut !== "yes" && heldOut !== "v292") || (flow !== null && !flows.includes(flow)) || !["regex", "deepseek", "regex+deepseek"].includes(values.get("--router") ?? "regex")) {
    throw new Error(USAGE);
  }
  const known = new Set([
    ...ALL_PLAN_CASES, ...INTAKE_CASES, ...INTENT_PLAN_CASES, ...INTENT_INTAKE_CASES, ...SHORT_PLAN_CASES, ...SHORT_INTAKE_CASES,
    ...ADJUST_PLAN_CASES, ...ADJUST_INTAKE_CASES, ...INFO_CASES, ...NOTES_CASES, ...KNOWLEDGE_CASES,
    ...ROUTE_CASES, ...TALK_CASES, ...PREF_CASES, ...LONG_CASES, ...FIX_CASES, ...V292_ROUTE_CASES, ...PICK_CASES, ...ROUTE_E2E_CASES, ...CITY_CASES, ...KB_CITY_CASES, ...PLAY_CASES, ...YUNLING_SHORT_CASES,
    ...DAILY_CITY_CASES, ...STAY_PLAN_CASES, ...STAY_CHAT_CASES, ...OUTING_INTAKE_CASES,
    ...TRANSFER_DAY_CASES, ...ALLOCATION_CASES, ...OUTING_E2E_CASES, ...CROSS_DAY_CASES, ...REVIEW_CASES, ...LODGING_CASES, ...SPLIT_CHAT_CASES, ...SPLIT_OUTING_CASES,
  ].map((item) => item.id));
  const cases = values.has("--case") ? new Set(values.get("--case")!.split(",")) : null;
  if (cases && [...cases].some((id) => !known.has(id))) throw new Error("Unknown case");
  return { live: policy === "live", suite: suite as Suite, cases, repeat, heldOut: heldOut === "yes", newHoldout: heldOut === "v292", router: (values.get("--router") ?? "regex") as Options["router"], flow: flow as Options["flow"] };
}

async function liveModels() {
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (process.env.AGENT_LIVE_ENABLED !== "true") throw new Error("Live disabled");
  const profileId = process.env.AGENT_MODEL_PROFILE;
  if (!profileId) throw new Error("Missing profile");
  const config: unknown = JSON.parse(await readFile(join(root, "agent-models.local.json"), "utf8"));
  const { resolveProfile } = await import("@tripquest/agent/live");
  const { createDayLiveModel } = await import("@tripquest/agent/day-live");
  const { createChatLiveModel } = await import("@tripquest/agent/chat-live");
  const { createShortLiveModel } = await import("@tripquest/agent/short-live");
  const { createNotesLiveModel } = await import("@tripquest/agent/notes-live");
  const { createDeepSeekIntentRouter } = await import("@tripquest/agent/intent-live");
  const { createChatSummarizer } = await import("@tripquest/agent/chat-summary");
  const { createAllocationRequest } = await import("@tripquest/agent/outing-allocate");
  const { createReviewRequest, createJudgeRequest } = await import("@tripquest/agent/outing-review-live");
  const { profile } = resolveProfile(config, profileId, process.env);
  const budget = v21ModelBudget(outputRoot);
  const beforeRequest = async () => {
    if (budget.used() >= RUN_LIMIT) throw new Error("Run budget exhausted");
    await budget.beforeRequest();
  };
  const options = { config, profileId, environment: process.env, beforeRequest };
  return {
    budget,
    profileId,
    configuredModel: profile.model,
    day: () => createDayLiveModel(options),
    chat: () => createChatLiveModel(options),
    short: () => createShortLiveModel(options),
    notes: () => createNotesLiveModel(options),
    router: () => createDeepSeekIntentRouter(options),
    summarizer: () => createChatSummarizer(options),
    allocator: () => createAllocationRequest(options),
    reviewer: () => createReviewRequest(options),
    judge: () => createJudgeRequest(options),
  };
}

async function main() {
  const { live, suite, cases, repeat, heldOut, newHoldout, router: chatRouter, flow } = parse(process.argv.slice(2));
  const intentPlan = INTENT_PLAN_CASES.filter((item) => heldOut || !item.heldOut);
  const intentIntake = INTENT_INTAKE_CASES.filter((item) => heldOut || !item.heldOut);
  // Each far case runs twice: as asked, and walking only (how V2.1 read it) for comparison.
  const chatOnly = suite === "short" || suite === "adjust" || suite === "info" || suite === "notes" || suite === "knowledge" || V29_SUITES.includes(suite);
  const planCases = (chatOnly ? [] : suite === "intent" ? intentPlan : [...ALL_PLAN_CASES, ...intentPlan])
    .filter((item) => !cases || cases.has(item.id))
    .flatMap((item) => (item.far ? [item, walkingOnly(item)] : [item]));
  const shortIntake = SHORT_INTAKE_CASES.filter((item) => heldOut || !item.heldOut);
  const shortPlan = SHORT_PLAN_CASES.filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
  const intakeCases = (suite === "adjust" || suite === "info" || suite === "notes" || suite === "knowledge" || V29_SUITES.includes(suite) ? [] : suite === "short" ? shortIntake : suite === "intent" ? intentIntake : [...INTAKE_CASES, ...intentIntake, ...shortIntake])
    .filter((item) => !cases || cases.has(item.id));
  const models = live ? await liveModels() : null;
  // V2.9.3：--router deepseek 时所有对话评测都用 DeepSeek 分流（失败或超时仍退回正则，与产品相同）。
  if (chatRouter === "deepseek" || chatRouter === "regex+deepseek") {
    if (!models) throw new Error(`--router ${chatRouter} needs --policy live`);
    // V4.1：regex+deepseek 是级联（正则拿不准的才问 DeepSeek）。
    setEvalChatRouter(chatRouter === "deepseek" ? models.router() : createRegexCascadeRouter(models.router()));
  }
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());

  const plan: PlanRow[] = [];
  const intake: IntakeRow[] = [];
  // The free rule policy always runs with the planning suite, so its report has a baseline.
  if (suite !== "intake") for (const item of planCases) plan.push(await runPlanCase(item, "scripted"));
  if (models && suite !== "intake") {
    for (let round = 0; round < repeat; round += 1) {
      for (const item of planCases) {
        if (controller.signal.aborted) break;
        plan.push(await evalCase("plan", item.id, () => runPlanCase(item, "live", models.day, controller.signal)));
      }
    }
  }
  // V2.4 short trips: the rules policy once, the live model per round.
  const short: ShortRow[] = [];
  // V2.9.2：SHORT_PICKER=jev 时短途的挑选先交给 Jev（与产品的开关同名）。
  const shortPicker = process.env.SHORT_PICKER === "jev"
    ? createJevPicker(createJevClient({ apiKey: process.env.TYPESAFE_API_KEY, model: process.env.JEV_MODEL }))
    : undefined;
  // V2.10：--suite shortcity 跑云岭市的短途（同一套判分）。
  const shortCases = suite === "shortcity"
    ? YUNLING_SHORT_CASES.filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)))
    : shortPlan;
  if (suite === "short" || suite === "shortcity" || suite === "all") {
    const runShort = (item: (typeof shortPlan)[number], policy: "scripted" | "live") => (flow ?? "short") === "day"
      ? runShortAsDay(item, policy, models?.day)
      : runShortFlow(item, policy, models?.short, shortPicker);
    for (const item of shortCases) short.push(await runShort(item, "scripted"));
    for (let round = 0; models && round < repeat; round += 1) {
      for (const item of shortCases) {
        if (controller.signal.aborted) break;
        short.push(await evalCase("short", item.id, () => runShort(item, "live")));
      }
    }
  }
  // V2.5 adjusting a saved trip: the rules policy once, the live model per round; then intake.
  const adjust: AdjustRow[] = [];
  const adjustIntake: AdjustIntakeRow[] = [];
  if (suite === "adjust" || suite === "all") {
    const adjustPlan = ADJUST_PLAN_CASES.filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    const runAdjust = (item: (typeof adjustPlan)[number], policy: "scripted" | "live") => flow === "day"
      ? runAdjustAsDay(item, policy, models?.day)
      : runAdjustFlow(item, policy, models?.day, models?.short);
    for (const item of adjustPlan) adjust.push(await runAdjust(item, "scripted"));
    for (let round = 0; models && round < repeat; round += 1) {
      for (const item of adjustPlan) {
        if (controller.signal.aborted) break;
        adjust.push(await evalCase("adjust", item.id, () => runAdjust(item, "live")));
      }
    }
    const asked = ADJUST_INTAKE_CASES.filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (let round = 0; models && round < repeat; round += 1) {
      for (const item of asked) {
        if (controller.signal.aborted) break;
        adjustIntake.push(await evalCase("adjustIntake", item.id, () => runAdjustIntake(item, models.chat)));
      }
    }
  }
  // V2.7 questions with sources: live model only, like intake.
  const info: InfoRow[] = [];
  if (models && (suite === "info" || suite === "all")) {
    const asked = INFO_CASES.filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (let round = 0; round < repeat; round += 1) {
      for (const item of asked) {
        if (controller.signal.aborted) break;
        info.push(await evalCase("info", item.id, () => runInfoCase(item, models.chat)));
      }
    }
  }
  // V2.7.2 "出发须知": live model only; --flow per_stop is the one-call-per-stop comparison.
  const notes: NotesRow[] = [];
  if (models && (suite === "notes" || suite === "all")) {
    const asked = NOTES_CASES.filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (let round = 0; round < repeat; round += 1) {
      for (const item of asked) {
        if (controller.signal.aborted) break;
        notes.push(await evalCase("notes", item.id, () => runNotesCase(item, models.notes, flow === "per_stop" ? "per_stop" : "batch")));
      }
    }
  }
  // V2.8 knowledge questions: live model only; --flow web_only / no_tools are the baselines.
  const knowledge: KnowledgeRow[] = [];
  const knowledgeFlow: KnowledgeFlow = flow === "web_only" || flow === "no_tools" ? flow : "kb";
  if (models && (suite === "knowledge" || suite === "all")) {
    const asked = KNOWLEDGE_CASES.filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (let round = 0; round < repeat; round += 1) {
      for (const item of asked) {
        if (controller.signal.aborted) break;
        knowledge.push(await evalCase("knowledge", item.id, () => runKnowledgeCase(item, models.chat, knowledgeFlow)));
      }
    }
  }
  // V2.9 routing: the current product's rules need no model (other routers arrive in step 2).
  const route: RouteRow[] = [];
  // V2.9 vector routing: the V2.8 embedding model through DashScope (key from the workspace .env).
  const embedder = () => {
    const key = process.env.DASHSCOPE_API_KEY?.trim();
    if (!key) throw new Error("DASHSCOPE_API_KEY is not set");
    return new DashScopeEmbeddingProvider({ key, fetch: globalThis.fetch, now: () => new Date().toISOString(), model: "qwen3.7-text-embedding-flash", dimensions: 1024 });
  };
  const tune: Awaited<ReturnType<typeof tuneEmbeddingRouter>> | null = suite === "route-tune" ? await tuneEmbeddingRouter(embedder()) : null;
  if (tune) {
    console.log(`exemplars ${tune.exemplars} (${INTENT_EXEMPLARS_VERSION}), embedding requests ${tune.requests}`);
    for (const row of tune.rows.slice(0, 20)) {
      console.log(`k=${row.settings.k} min=${row.settings.minSimilarity} band=${row.settings.band.low}-${row.settings.band.high}: vote exact ${row.voteExact}/${tune.exemplars}, planning missed ${row.planningMissed}, confident ${row.confident} (exact ${row.confidentExact})`);
    }
  }
  if (suite === "route") {
    // --flow current (the V2.8 product, default) | regex | deepseek | embedding | cascade (live, repeated).
    const needModel = () => {
      if (!models) throw new Error("this routing flow needs --policy live");
      return models;
    };
    // Dev cases are in the exemplar library: route them leaving their own exemplar out.
    const router: EvalRouter = flow === "regex" ? fromIntentRouter(regexRouter)
      : flow === "deepseek" ? fromIntentRouter(needModel().router())
        : flow === "regex+deepseek" ? fromIntentRouter(createRegexCascadeRouter(needModel().router()))
        : flow === "embedding" ? fromIntentRouter(createEmbeddingIntentRouter({ embedder: embedder(), leaveOut: true, settings: DEFAULT_EMBEDDING_ROUTER }))
          : flow === "cascade" ? fromIntentRouter(createEmbeddingIntentRouter({ embedder: embedder(), leaveOut: true, escalate: needModel().router(), settings: DEFAULT_CASCADE_ROUTER }))
            // V2.9.2：Jev 1.14（固定版本）与 1.13；JEV_INTENT_MARGIN 只给选阈值用（缺省用选定的值）。
            : flow === "jev" || flow === "jev13" ? fromIntentRouter(jevIntentRouter(
              createJevClient({ apiKey: process.env.TYPESAFE_API_KEY, model: flow === "jev13" ? "jev-1.13.0" : process.env.JEV_MODEL }),
              process.env.JEV_INTENT_MARGIN ? { margin: Number(process.env.JEV_INTENT_MARGIN) } : {},
            ), flow)
              : currentProductRouter;
    const rounds = flow === "deepseek" || flow === "regex+deepseek" || flow === "embedding" || flow === "cascade" || flow === "jev" || flow === "jev13" ? repeat : 1;
    for (let round = 0; round < rounds; round += 1) {
      const pool = newHoldout ? V292_ROUTE_CASES : ROUTE_CASES.filter((entry) => heldOut || !entry.heldOut);
      for (const item of pool.filter((entry) => !cases || cases.has(entry.id))) {
        if (controller.signal.aborted) break;
        route.push(await evalCase("route", item.id, () => runRouteCase(item, router)));
      }
    }
  }
  // V2.10 各种玩法：云岭市的一日规划，规则策略一次、真实模型每轮一次（与 V2.1 规划评测相同）。
  const play: PlayRow[] = [];
  if (suite === "play" || suite === "stay") {
    const asked = (suite === "stay" ? STAY_PLAN_CASES : PLAY_CASES).filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (const item of asked) play.push(await runPlayCase(item, "scripted"));
    for (let round = 0; models && round < repeat; round += 1) {
      for (const item of asked) {
        if (controller.signal.aborted) break;
        play.push(await evalCase("play", item.id, () => runPlayCase(item, "live", models.day)));
      }
    }
  }
  // V2.11 一天里的固定交通（§4.4）：规则（脚本模型）和模型各跑一遍。
  const transferDays: TransferRow[] = [];
  if (suite === "transfer") {
    const asked = TRANSFER_DAY_CASES.filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (const item of asked) transferDays.push(await runTransferCase(item, "scripted"));
    for (let round = 0; models && round < repeat; round += 1) {
      for (const item of asked) {
        if (controller.signal.aborted) break;
        transferDays.push(await evalCase("transferDays", item.id, () => runTransferCase(item, "live", models.day)));
      }
    }
  }
  // V2.11 分到各天（§4.5）：规则分配跑一遍，模型分配（含打回与兜底）按 repeat 跑。
  const allocations: AllocationRow[] = [];
  if (suite === "allocation" || suite === "accept") {
    const asked = (suite === "accept" ? ACCEPT_ALLOCATION_CASES : ALLOCATION_CASES).filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (const item of asked) allocations.push(await runAllocationCase(item, "rules"));
    for (let round = 0; models && round < repeat; round += 1) {
      const request = models.allocator();
      for (const item of asked) {
        if (controller.signal.aborted) break;
        allocations.push(await evalCase("allocations", item.id, () => runAllocationCase(item, "live", request)));
      }
    }
  }
  // V2.11 出游端到端（§4.6）：规则分配 + 脚本模型跑一遍，模型分配 + 模型规划按 repeat 跑。
  const trips: OutingRow[] = [];
  if (suite === "trip" || suite === "accept") {
    const asked = (suite === "accept" ? ACCEPT_OUTING_CASES : OUTING_E2E_CASES).filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (const item of asked) trips.push(await runOutingCase(item, "scripted"));
    for (let round = 0; models && round < repeat; round += 1) {
      const allocator = models.allocator();
      for (const item of asked) {
        if (controller.signal.aborted) break;
        trips.push(await evalCase("trips", item.id, () => runOutingCase(item, "live", { day: models.day, allocator, reviewer: models.reviewer(), judge: models.judge() })));
      }
    }
  }
  // V3.2 审查（stages/V3.2.md §4）：故意不好的分配，脚本模型跑一遍、模型按 repeat 跑；OUTING_REVIEW 决定排完审不审查。
  const reviews: ReviewRow[] = [];
  if (suite === "review") {
    const asked = REVIEW_CASES.filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (const item of asked) reviews.push(await runReviewCase(item, "scripted"));
    for (let round = 0; models && round < repeat; round += 1) {
      for (const item of asked) {
        if (controller.signal.aborted) break;
        reviews.push(await evalCase("reviews", item.id, () => runReviewCase(item, "live", { day: models.day, reviewer: models.reviewer(), judge: models.judge() })));
      }
    }
  }
  // V3.3 住处（stages/V3.3.md §4）：住处没定的出游，脚本模型跑一遍、模型按 repeat 跑。
  const lodgings: LodgingRow[] = [];
  if (suite === "lodging") {
    const asked = LODGING_CASES.filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (const item of asked) lodgings.push(await runLodgingCase(item, "scripted"));
    for (let round = 0; models && round < repeat; round += 1) {
      for (const item of asked) {
        if (controller.signal.aborted) break;
        lodgings.push(await evalCase("lodgings", item.id, () => runLodgingCase(item, "live", { day: models.day })));
      }
    }
  }
  // V4.2 规划可靠性（stages/V4.2.md §4.1）：评测世界只走一日规划，同住处题，脚本模型跑一遍、模型按 repeat 跑。
  const reliabilities: ReliabilityRow[] = [];
  if (suite === "reliability") {
    const asked = RELIABILITY_CASES.filter((item) => !cases || cases.has(item.id));
    for (const item of asked) reliabilities.push(await runReliabilityCase(item, "scripted"));
    for (let round = 0; models && round < repeat; round += 1) {
      for (const item of asked) {
        if (controller.signal.aborted) break;
        reliabilities.push(await evalCase("reliabilities", item.id, () => runReliabilityCase(item, "live", models.day, controller.signal)));
      }
    }
  }
  // V3.4 搜索兜底题（stages/V3.4.md §4.1）：同住处题，脚本模型跑一遍、模型按 repeat 跑；对话题在下面和 V2.9 对话题一起跑。
  const splitOutings: SplitOutingRow[] = [];
  if (suite === "split") {
    const asked = SPLIT_OUTING_CASES.filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (const item of asked) splitOutings.push(await runSplitOutingCase(item, "scripted"));
    for (let round = 0; models && round < repeat; round += 1) {
      for (const item of asked) {
        if (controller.signal.aborted) break;
        splitOutings.push(await evalCase("splitOutings", item.id, () => runSplitOutingCase(item, "live", { day: models.day })));
      }
    }
  }
  // V2.11 跨天调整与改车次（§4.7）：只有模型版（理解要靠对话模型）。
  const crossDays: CrossDayRow[] = [];
  if (suite === "crossday") {
    const asked = CROSS_DAY_CASES.filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (let round = 0; models && round < repeat; round += 1) {
      for (const item of asked) {
        if (controller.signal.aborted) break;
        crossDays.push(await evalCase("crossDays", item.id, () => runCrossDayCase(item, { chat: models.chat, day: models.day, reviewer: models.reviewer })));
      }
    }
  }
  // V2.9.2 挑地点：同一批固定候选交给 DeepSeek（现有）或 Jev，不调高德。
  // V4.7 第 1 步闸门（stages/V4.7.md §4.1）：人造方案判断准不准，只用模型。
  const judges: JudgeRow[] = [];
  if (suite === "judge" && models) {
    const asked = JUDGE_CASES.filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (let round = 0; round < repeat; round += 1) {
      for (const item of asked) {
        if (controller.signal.aborted) break;
        judges.push(await evalCase("judges", item.id, () => runJudgeCase(item, models.judge())));
      }
    }
  }
  // V4.7 修复效果（stages/V4.7.md §4.2）：需求题，判定由代码查；OUTING_REVIEW 选 single / agent。
  const repairs: RepairRow[] = [];
  if (suite === "repair" && models) {
    const asked = REPAIR_CASES.filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (let round = 0; round < repeat; round += 1) {
      for (const item of asked) {
        if (controller.signal.aborted) break;
        repairs.push(await evalCase("repairs", item.id, () => runRepairCase(item, { day: models.day, reviewer: models.reviewer(), judge: models.judge() })));
      }
    }
  }
  const picks: PickRow[] = [];
  if (suite === "picks") {
    // --flow deepseek（现有，缺省）| jev | jev13；JEV_PICK_FIT 只给选阈值用。
    const picker: EvalPicker = (() => {
      if (flow === "jev" || flow === "jev13") {
        const client = createJevClient({ apiKey: process.env.TYPESAFE_API_KEY, model: flow === "jev13" ? "jev-1.13.0" : process.env.JEV_MODEL });
        return jevPicker(client, process.env.JEV_PICK_FIT ? Number(process.env.JEV_PICK_FIT) : undefined);
      }
      if (!models) throw new Error("the DeepSeek picker needs --policy live");
      return deepSeekPicker(models.short);
    })();
    for (let round = 0; round < repeat; round += 1) {
      for (const item of PICK_CASES.filter((entry) => (heldOut || !entry.heldOut) && (!cases || cases.has(entry.id)))) {
        if (controller.signal.aborted) break;
        picks.push(await evalCase("picks", item.id, () => runPickCase(item, picker)));
      }
    }
  }
  // V2.9 conversations (chitchat and advice, preferences, long conversations): live model only.
  const conversations: ConversationRow[] = [];
  const v29Sets: Record<string, readonly ConversationCase[]> = { talk: TALK_CASES, pref: PREF_CASES, long: LONG_CASES, fix: FIX_CASES, e2e: ROUTE_E2E_CASES, city: CITY_CASES, kbcity: KB_CITY_CASES, daily: DAILY_CITY_CASES, stay: STAY_CHAT_CASES, outing: OUTING_INTAKE_CASES, accept: ACCEPT_CHAT_CASES, split: SPLIT_CHAT_CASES, rides: RIDES_CASES, stays: STAYS_CASES, dates: DATES_CASES, dates45: DATES45_CASES };
  if (models && v29Sets[suite]) {
    const asked = v29Sets[suite].filter((item) => (heldOut || !item.heldOut) && (!cases || cases.has(item.id)));
    for (let round = 0; round < repeat; round += 1) {
      for (const item of asked) {
        if (controller.signal.aborted) break;
        // --flow summary（长对话对照 B）：窗口外的旧消息先压成摘要。V2.9.1 题集按产品现状总是带摘要。
        const summarizer = flow === "summary" || suite === "fix" || suite === "e2e" ? models.summarizer() : null;
        const summarize = summarizer ? (input: Parameters<typeof summarizer.summarize>[0]) => summarizer.summarize(input, AbortSignal.timeout(20_000)) : undefined;
        // V3.6：rides 题集每轮之后补交通（--flow no_fill 是之前的产品）。
        // V4.3：stays 题集每轮之后走产品的补卡片（认“住在哪”、挪车的日子、补交通）。
        // V4.4：dates 题集同样每轮之后走产品的补卡片。
        const afterTurn = suite === "stays" ? staysAfterTurn : suite === "dates" || suite === "dates45" ? datesAfterTurn : suite === "rides" && flow !== "no_fill" ? fillRidesAfterTurn : undefined;
        conversations.push(await evalCase("conversations", item.id, () => runConversationRow(suite as ConversationRow["suite"], item, models.chat, summarize, afterTurn)));
      }
    }
  }
  if (models && suite !== "plan" && suite !== "adjust" && suite !== "info" && suite !== "notes" && suite !== "knowledge" && !V29_SUITES.includes(suite)) {
    // Intake understands free text: there is no rule baseline for it, only the live model.
    for (let round = 0; round < repeat; round += 1) {
      for (const item of intakeCases) {
        if (controller.signal.aborted) break;
        intake.push(await evalCase("intake", item.id, () => runIntakeCase(item, models.chat, controller.signal)));
      }
    }
  }
  const report: V21Report = {
    runId: `v21-${randomUUID()}`,
    startedAt: new Date().toISOString(),
    git: git(),
    datasets: {
      intake: { version: INTAKE_DATASET_VERSION, digest: intakeDatasetDigest(), cases: INTAKE_CASES.length },
      plan: { version: PLAN_DATASET_VERSION, digest: planDatasetDigest(), cases: ALL_PLAN_CASES.length },
      intent: {
        version: INTENT_DATASET_VERSION,
        digest: intentDatasetDigest(),
        cases: INTENT_PLAN_CASES.length + INTENT_INTAKE_CASES.length,
        heldOutIncluded: heldOut,
      },
      short: { version: SHORT_DATASET_VERSION, digest: shortDatasetDigest(), cases: SHORT_PLAN_CASES.length + SHORT_INTAKE_CASES.length, flow: flow ?? "short" },
      notes: { version: NOTES_DATASET_VERSION, digest: notesDatasetDigest(), cases: NOTES_CASES.length },
      knowledge: { version: KNOWLEDGE_DATASET_VERSION, digest: knowledgeDatasetDigest(), cases: KNOWLEDGE_CASES.length, flow: knowledgeFlow },
      v29: {
        route: { version: ROUTE_DATASET_VERSION, digest: routeDatasetDigest(), cases: ROUTE_CASES.length },
        talk: { version: TALK_DATASET_VERSION, digest: talkDatasetDigest(), cases: TALK_CASES.length },
        pref: { version: PREF_DATASET_VERSION, digest: prefDatasetDigest(), cases: PREF_CASES.length },
        long: { version: LONG_DATASET_VERSION, digest: longDatasetDigest(), cases: LONG_CASES.length },
        fix: { version: FIX_DATASET_VERSION, digest: fixDatasetDigest(), cases: FIX_CASES.length },
      },
      v210: {
        city: { version: CITY_DATASET_VERSION, digest: cityDatasetDigest(), cases: CITY_CASES.length + KB_CITY_CASES.length },
        play: { version: PLAY_DATASET_VERSION, digest: playDatasetDigest(), cases: PLAY_CASES.length },
        shortCity: { version: YUNLING_SHORT_VERSION, digest: yunlingShortDigest(), cases: YUNLING_SHORT_CASES.length },
      },
      v211: {
        dailyCity: { version: DAILY_CITY_DATASET_VERSION, digest: dailyCityDatasetDigest(), cases: DAILY_CITY_CASES.length },
        stay: { version: STAY_DATASET_VERSION, digest: stayDatasetDigest(), cases: STAY_PLAN_CASES.length + STAY_CHAT_CASES.length },
        outingIntake: { version: OUTING_INTAKE_VERSION, digest: outingIntakeDigest(), cases: OUTING_INTAKE_CASES.length },
        acceptFix: { version: ACCEPT_FIX_VERSION, digest: acceptFixDigest(), cases: ACCEPT_CHAT_CASES.length + ACCEPT_ALLOCATION_CASES.length + ACCEPT_OUTING_CASES.length },
        outingPlan: {
          version: OUTING_PLAN_VERSION,
          digest: outingPlanDigest(),
          cases: TRANSFER_DAY_CASES.length + ALLOCATION_CASES.length + OUTING_E2E_CASES.length + CROSS_DAY_CASES.length,
        },
      },
      v293: {
        routeE2e: { version: ROUTE_E2E_VERSION, digest: routeE2eDigest(), cases: ROUTE_E2E_CASES.length },
      },
      v32: {
        review: { version: REVIEW_DATASET_VERSION, digest: reviewDatasetDigest(), cases: REVIEW_CASES.length },
      },
      v33: {
        lodging: { version: LODGING_DATASET_VERSION, digest: lodgingDatasetDigest(), cases: LODGING_CASES.length },
      },
      v43: {
        stays: { version: STAYS_DATASET_VERSION, digest: staysDigest(), cases: STAYS_CASES.length },
      },
      v44: {
        dates: { version: DATES_DATASET_VERSION, digest: datesDigest(), cases: DATES_CASES.length },
      },
      v47: {
        judge: { version: JUDGE_DATASET_VERSION, digest: judgeDigest(), cases: JUDGE_CASES.length },
        repair: { version: REPAIR_DATASET_VERSION, digest: repairDigest(), cases: REPAIR_CASES.length },
      },
      v45: {
        dates: { version: DATES45_DATASET_VERSION, digest: dates45Digest(), cases: DATES45_CASES.length },
      },
      v42: {
        reliability: { version: RELIABILITY_DATASET_VERSION, digest: reliabilityDatasetDigest(), cases: RELIABILITY_CASES.length },
      },
      v34: {
        split: { version: SPLIT_DATASET_VERSION, digest: splitDatasetDigest(), cases: SPLIT_CHAT_CASES.length + SPLIT_OUTING_CASES.length },
      },
      v36: {
        // --flow no_fill 是补交通之前的产品（基线）。
        rides: { version: RIDES_VERSION, digest: ridesDigest(), cases: RIDES_CASES.length, flow: flow === "no_fill" ? "no_fill" : "fill" },
      },
      v292: {
        routeHoldout: { version: V292_ROUTE_DATASET_VERSION, digest: v292RouteDigest(), cases: V292_ROUTE_CASES.length },
        picks: { version: PICKS_DATASET_VERSION, digest: picksDatasetDigest(), cases: PICK_CASES.length },
      },
      info: { version: INFO_DATASET_VERSION, digest: infoDatasetDigest(), cases: INFO_CASES.length, web: INFO_WEB },
      adjust: { version: ADJUST_DATASET_VERSION, digest: adjustDatasetDigest(), cases: ADJUST_PLAN_CASES.length + ADJUST_INTAKE_CASES.length, flow: flow === "day" ? "day" : "adjust" },
    },
    repeat,
    chatRouter,
    live: models ? { profileId: models.profileId, configuredModel: models.configuredModel, modelRequests: models.budget.used() } : null,
    intake,
    plan,
    short,
    adjust,
    adjustIntake,
    info,
    notes,
    knowledge,
    route,
    conversations,
    picks,
    play,
    ...(transferDays.length ? { transferDays } : {}),
    ...(allocations.length ? { allocations } : {}),
    ...(trips.length ? { trips } : {}),
    ...(crossDays.length ? { crossDays } : {}),
    ...(reviews.length ? { reviews } : {}),
    ...(judges.length ? { judges } : {}),
    ...(repairs.length ? { repairs } : {}),
    ...(lodgings.length ? { lodgings } : {}),
    ...(reliabilities.length ? { reliabilities } : {}),
    ...(splitOutings.length ? { splitOutings } : {}),
    agents: [...agentRows()],
    ...(repairTraces().length ? { repairTraces: [...repairTraces()] } : {}),
  };
  const folder = join(outputRoot, report.runId);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(folder, "report.md"), renderV21(report));
  const violations = plan.reduce((total, row) => total + row.violations.length, 0);
  console.log(`plan rows ${plan.length}, intake rows ${intake.length}, violations ${violations}; ${folder}`);
  // Misses are findings; only violations fail the command.
  process.exitCode = violations ? 1 : 0;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown";
  console.error(`V2.1 evaluation failed: ${message.slice(0, 200)}. No credentials or raw responses are logged.`);
  process.exitCode = 2;
});
