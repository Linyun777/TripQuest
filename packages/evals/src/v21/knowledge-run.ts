import { evalChatRouter } from "../v293/chat-router";
import type { RequirementsDraft } from "@tripquest/application/conversation";
import { createChatRunner, type ChatDecisionModel } from "@tripquest/agent/chat";
import { FakeKnowledge, KnowledgeWeb, knowledgeChecks, type KnowledgeCase } from "./knowledge-dataset";
import { FORECASTS, locatedDraft, V21_NOW, V21World } from "./world";

/** 对照模式：kb 使用产品资料库与搜索，web_only 只用搜索，no_tools 关闭二者。 */
export type KnowledgeFlow = "kb" | "web_only" | "no_tools";

export interface KnowledgeRow {
  readonly suite: "knowledge";
  readonly caseId: string;
  readonly flow: KnowledgeFlow;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly passed: boolean;
  readonly modelRequests: number;
  readonly order: readonly string[];
  readonly sources: readonly string[];
  readonly reply: string;
}

/** 通过产品自身聊天 runner 跑一道题，资料库和搜索均用固定事实，保证方案对照可复现。 */
export async function runKnowledgeCase(item: KnowledgeCase, model: () => ChatDecisionModel, flow: KnowledgeFlow): Promise<KnowledgeRow> {
  const world = new V21World(FORECASTS.dry);
  const order: string[] = [];
  const knowledge = new FakeKnowledge(order);
  const web = new KnowledgeWeb(order);
  const draft: RequirementsDraft = locatedDraft();
  const result = await createChatRunner({
    ...evalChatRouter(),
    cities: world,
    model: model(),
    places: world,
    weather: world,
    ...(flow === "kb" ? { knowledge } : {}),
    ...(flow !== "no_tools" && !item.webOff ? { web } : {}),
  }).run({ draft, history: [], userText: item.question, nowMs: V21_NOW }, { signal: new AbortController().signal });
  const completed = result.status === "completed" ? result : null;
  const sources = (completed?.reply.sources ?? []).map((source) => (source.kind === "kb" ? `kb:${source.chunkId}` : `web:${source.url}`));
  const reply = completed?.reply.text ?? "";
  // 三种流程使用相同问句和固定资料，只改变可用工具，便于判断 RAG 相对联网或无工具的效果。
  // 除回答内容外，还核对检索先后、引用是否真的给过、卡片是否被误改；固定世界不代表真实搜索质量。
  const checks = knowledgeChecks(item, {
    replies: [reply],
    failed: !completed || completed.reply.fallback,
    sources,
    kbQuestions: knowledge.questions,
    webQueries: web.queries,
    order,
    kbGiven: knowledge.given,
    webGiven: web.given.map((page) => page.url),
    cardChanged: completed?.draftChanged ?? false,
  });
  return {
    suite: "knowledge",
    caseId: item.id,
    flow,
    checks,
    passed: checks.every((check) => check.passed),
    modelRequests: result.counts.model,
    order,
    sources,
    reply,
  };
}
