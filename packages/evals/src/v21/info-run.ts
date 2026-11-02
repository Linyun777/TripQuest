import { evalChatRouter } from "../v293/chat-router";
import type { RequirementsDraft } from "@tripquest/application/conversation";
import { createChatRunner, type ChatDecisionModel } from "@tripquest/agent/chat";
import { TRIP_DATE, TRIP_NOW, TRIP_STOPS, tripStopName } from "./adjust-dataset";
import { tripDraft } from "./adjust-run";
import { FakeWeb, INFO_WEB, infoChecks, type InfoCase } from "./info-dataset";
import { FakeKnowledge, KNOWLEDGE_ON } from "./knowledge-dataset";
import { FORECASTS, locatedDraft, V21_NOW, V21World } from "./world";


export interface InfoRow {
  readonly suite: "info";
  readonly caseId: string;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly passed: boolean;
  readonly modelRequests: number;
  readonly queries: readonly string[];
  readonly sources: number;
  readonly replies: readonly string[];
}

/** One question, turn by turn, through the product's own chat runner and a fixed invented web. */
export async function runInfoCase(item: InfoCase, model: () => ChatDecisionModel): Promise<InfoRow> {
  const world = new V21World(FORECASTS.dry);
  const web = new FakeWeb();
  const trip = item.trip ? {
    version: 1,
    date: TRIP_DATE,
    stops: TRIP_STOPS.map((stop) => ({
      key: stop.key, name: tripStopName(stop), startsAt: stop.startsAt, endsAt: stop.endsAt, status: "todo" as const, for: stop.interest,
    })),
  } : undefined;
  let draft: RequirementsDraft = trip ? tripDraft() : locatedDraft();
  const history: { role: "user" | "assistant"; text: string }[] = trip ? [
    { role: "user", text: "明天9点从东门广场出发再回来，想看展、看越剧、喝茶" },
    { role: "assistant", text: "（方案已保存为行程）" },
  ] : [];
  const replies: string[] = [];
  let failed = false;
  let sources: readonly string[] = [];
  let adjusted = false;
  let cardChanged = false;
  let modelRequests = 0;
  const extra = { ...(INFO_WEB ? { web } : {}), ...(KNOWLEDGE_ON ? { knowledge: new FakeKnowledge() } : {}) };
  for (const text of item.turns) {
    const result = await createChatRunner({ model: model(), places: world, weather: world, cities: world, ...extra, ...evalChatRouter() }).run(
      { draft, history, userText: text, nowMs: trip ? TRIP_NOW : V21_NOW, ...(trip ? { trip } : {}) },
      { signal: new AbortController().signal },
    );
    modelRequests += result.counts.model;
    history.push({ role: "user", text });
    if (result.status !== "completed") {
      failed = true;
      replies.push("");
      continue;
    }
    draft = result.draft;
    adjusted ||= !!result.adjust;
    cardChanged ||= result.draftChanged;
    failed ||= result.reply.fallback;
    replies.push(result.reply.text);
    history.push({ role: "assistant", text: result.reply.text });
    // V2.7 replies carry the sources they cite; before it there are none. V2.8: a cited passage
    // (none of these invented places is in the knowledge base) fails "sources_were_given".
    sources = (result.reply.sources ?? []).map((source) => (source.kind === "kb" ? `kb:${source.chunkId}` : source.url));
  }
  const outcome = { replies, failed, sources, queries: web.queries, given: web.given.map((result) => result.url), draft, cardChanged, adjusted };
  const checks = infoChecks(item, outcome);
  return {
    suite: "info",
    caseId: item.id,
    checks,
    passed: checks.every((check) => check.passed),
    modelRequests,
    queries: web.queries,
    sources: sources.length,
    replies,
  };
}
