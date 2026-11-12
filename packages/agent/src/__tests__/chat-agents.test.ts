import { describe, expect, it } from "vitest";
import { emptyDraft as blankDraft } from "@tripquest/application/conversation";
import type { PlaceSummary, ProviderEvidence, WeatherProvider, WebSearchProvider } from "@tripquest/providers";
import { CHAT_SYSTEM_PROMPT, chatSystemPrompt, createChatRunner } from "../chat-index";
import { CHAT_AGENT_PROMPT_PARTS, CHAT_INFO_ROLE, CHAT_NEXT_RULES, chatAgentPrompt, type ChatAgentPromptParts, type ChatSpecialistId } from "../chat-agent-prompts";
import { pickAgents } from "../chat-agents";
import type { ChatDecisionContext, ChatDecisionModel, ChatPlaceSearch, ChatTrip } from "../chat-contracts";
import { guessedQuestion, INTENT_FLAGS, type IntentFlag } from "../intent";

// Invented places, pages and trips; no provider data.
const NOW = Date.parse("2026-10-13T02:00:00Z"); // 10:00 in Hangzhou
const evidence: ProviderEvidence = { provider: "amap", sourceKind: "live", attribution: "高德地图", retrievedAt: "2026-10-13T02:00:00Z" };
const place = (id: string, name: string): PlaceSummary => ({
  ref: { provider: "amap", externalId: id },
  name,
  address: "合成路",
  cityAdcode: "330100",
  location: { longitude: 120.1, latitude: 30.2, coordinateSystem: "gcj02" },
});
const search: ChatPlaceSearch = {
  async searchPlaces(request) {
    const found = { 合成古寺: [place("SYN-TEMPLE", "合成古寺")], 湖滨: [place("SYN-LAKE", "合成湖滨")] }[request.query] ?? [];
    return { status: "ok", data: { items: found, truncated: false }, evidence };
  },
};
const weather: WeatherProvider = {
  async getWeatherForecast() {
    return { status: "ok", data: { cityAdcode: "330100", reportedAt: "2026-10-13T08:00:00+08:00", days: [] }, evidence };
  },
};
const web: WebSearchProvider = {
  async searchWeb() {
    return {
      status: "ok",
      data: { results: [{ title: "合成古寺预约公告", url: "https://example.invalid/t", site: "合成古寺", date: "2026-09-01", authority: 3, summary: "需实名预约。" }] },
      evidence,
    };
  },
};
const draft = () => ({ ...blankDraft(), city: { adcode: "330100", name: "杭州市", source: "located" as const } });
const trip: ChatTrip = {
  version: 1, date: "2026-10-13",
  stops: [{ key: "s1", name: "合成博物馆", startsAt: "09:30", endsAt: "11:00", status: "todo" }],
};

/** Replays fixed decisions (a throw where an Error is queued) and records each context with the system prompt it came with. */
function scripted(decisions: unknown[]) {
  const seen: { context: ChatDecisionContext; system: string | undefined }[] = [];
  const model: ChatDecisionModel = {
    mode: "scripted",
    provider: "test",
    model: "scripted",
    async decide(context, options) {
      seen.push({ context: structuredClone(context), system: options.system });
      const next = decisions.shift() ?? { action: "reply", text: "好" };
      return { decision: next, usage: null };
    },
  };
  return { model, seen };
}

const split = (model: ChatDecisionModel, userText: string, extra: { trip?: ChatTrip } = {}) =>
  createChatRunner({ model, places: search, weather, web }).run(
    { draft: draft(), history: [], userText, nowMs: NOW, ...extra },
    { signal: new AbortController().signal },
  );

const flags = (...on: IntentFlag[]) => Object.fromEntries(INTENT_FLAGS.map((flag) => [flag, on.includes(flag)])) as Record<IntentFlag, boolean>;

describe("V3.4 chat split into specialist agents", () => {
  it("picks in a fixed order, at most two, and always keeps the companion for a lasting preference", () => {
    const ids = (picked: ReturnType<typeof pickAgents>) => picked.map((item) => item.agent);
    expect(ids(pickAgents(flags("planning", "ask_timely"), false))).toEqual(["chat-intake", "chat-info"]);
    expect(ids(pickAgents(flags("adjust", "ask_timely"), true))).toEqual(["chat-trip", "chat-info"]);
    expect(ids(pickAgents(flags("planning"), true))).toEqual(["chat-trip"]);
    expect(ids(pickAgents(flags("planning", "ask_timely", "advice", "preference"), false))).toEqual(["chat-intake", "chat-companion"]);
    // 规划带着要建议：需求理解带着建议规则做（同拆开前），不另跑建议。
    expect(ids(pickAgents(flags("planning", "advice"), false))).toEqual(["chat-intake"]);
    expect(ids(pickAgents(flags("advice"), false))).toEqual(["chat-advice"]);
    // 闲聊只在纯闲聊时交给陪聊（“谢谢，明天想去…”按请求处理）；什么都没判出时是需求理解。
    expect(ids(pickAgents(flags("planning", "chitchat"), false))).toEqual(["chat-intake"]);
    expect(ids(pickAgents(flags("chitchat"), false))).toEqual(["chat-companion"]);
    expect(ids(pickAgents(flags(), false))).toEqual(["chat-intake"]);
    // V4.1：问句安全网的消息不再特殊处理（级联里交给模型判断），按判断出的意图一般地挑。
    expect(ids(pickAgents(flags("ask_timely", "ask_knowledge"), false))).toEqual(["chat-info"]);
    expect(ids(pickAgents(flags("planning"), false))).toEqual(["chat-intake"]);
    // 资料查询排在后面时只在像问句时才加。
    expect(ids(pickAgents(flags("adjust", "ask_timely"), true, { asks: false }))).toEqual(["chat-trip"]);
    expect(ids(pickAgents(flags("ask_timely"), false, { asks: false }))).toEqual(["chat-info"]);
    expect([guessedQuestion("晚上整两杯？"), guessedQuestion("灵峰古寺要预约吗"), guessedQuestion("不是要去，就问问那边好玩吗")]).toEqual([true, false, false]);
  });

  it("runs two agents in order: the second sees the card and what was said, the replies are joined, one question per turn", async () => {
    const { model, seen } = scripted([
      // chat-intake
      { action: "search_place", mention: "合成古寺", purpose: "visit" },
      { actions: [{ action: "update_requirements", patch: { date: "2026-10-14", addVisits: [{ place: { candidate: "c1" }, role: "optional" }] } }, { action: "reply", text: "好的，明天去合成古寺。几点出发？", ask: true }] },
      // chat-info：问了第二个问题，打回一次；仍问就不算问
      { action: "web_search", query: "合成古寺 预约", question: "合成古寺要预约吗" },
      { action: "reply", text: "据古寺9月的公告需要实名预约，要我提醒你吗？", sources: ["w1"], ask: true },
      { action: "reply", text: "据古寺9月的公告需要实名预约，去之前再看下官方渠道？", sources: ["w1"], ask: true },
    ]);
    const result = await split(model, "明天去合成古寺，要预约吗");
    expect(result).toMatchObject({ status: "completed", draftChanged: true, reply: { asking: true, fallback: false } });
    if (result.status !== "completed") return;
    expect(result.agents?.map((agent) => agent.id)).toEqual(["chat-intake", "chat-info"]);
    expect(result.reply.text).toBe("好的，明天去合成古寺。几点出发？据古寺9月的公告需要实名预约，去之前再看下官方渠道？");
    expect(result.reply.sources).toHaveLength(1);
    expect(result.trace?.hints).toContain("one_question: the reply before yours already asks the user something; do not ask another (ask false)");
    // 需求理解的提示词是拆开前的那份，加上“后面还有人做另一部分”；第二个看到改过的卡片、第一个说的话和它自己的规则。
    expect(seen[0].context.next).toBe("answers the question with sources");
    expect(seen[0].system).toBe(`${chatSystemPrompt(seen[0].context)}\n\n${CHAT_NEXT_RULES}`);
    expect(seen[0].system?.startsWith(CHAT_SYSTEM_PROMPT)).toBe(true);
    expect(seen[2].context.next).toBeUndefined();
    expect(seen[2].context.said).toEqual({ text: "好的，明天去合成古寺。几点出发？", asked: true });
    expect(JSON.stringify(seen[2].context.draft)).toContain("合成古寺");
    expect(seen[2].system).toContain(CHAT_INFO_ROLE);
    expect(seen[2].context.remaining.webSearches).toBe(2);
  });

  it("hands off once, as the first action, to an agent that has not run; anything else is sent back", async () => {
    const { model } = scripted([
      { action: "handoff", to: "chat-intake", reason: "另一天的新计划" },
      { action: "search_place", mention: "湖滨", purpose: "visit" },
      { actions: [{ action: "update_requirements", patch: { date: "2026-10-15", addVisits: [{ place: { candidate: "c1" }, role: "optional" }] } }, { action: "reply", text: "好的，后天去湖滨。" }] },
    ]);
    const handed = await split(model, "后天想去湖滨", { trip });
    expect(handed).toMatchObject({ status: "completed", draftChanged: true, reply: { text: "好的，后天去湖滨。" } });
    if (handed.status !== "completed") return;
    expect(handed.adjust).toBeUndefined();
    expect(handed.agents).toMatchObject([{ id: "chat-trip", handoffTo: "chat-intake" }, { id: "chat-intake", reason: "handoff:chat-trip" }]);

    // 还有自己的那部分（back）：需求理解先做卡片，资料查询再回来答，第一个知道后面还有人。
    const both = scripted([
      { action: "handoff", to: "chat-intake", reason: "也要排进计划", back: true },
      { action: "search_place", mention: "合成古寺", purpose: "visit" },
      { actions: [{ action: "update_requirements", patch: { date: "2026-10-14", addVisits: [{ place: { candidate: "c1" }, role: "optional" }] } }, { action: "reply", text: "好的，明天去合成古寺。" }] },
      { action: "web_search", query: "合成古寺 预约" },
      { action: "reply", text: "据古寺9月的公告需要实名预约。", sources: ["w1"] },
    ]);
    const returned = await split(both.model, "合成古寺要预约吗，明天带爸妈过去");
    expect(returned).toMatchObject({ status: "completed", draftChanged: true, reply: { text: "好的，明天去合成古寺。据古寺9月的公告需要实名预约。" } });
    expect(returned.status === "completed" && returned.agents?.map((agent) => agent.id)).toEqual(["chat-info", "chat-intake", "chat-info"]);
    expect(both.seen[1].context.next).toBe("answers the question with sources");

    // 第一个说到了后面那个的部分（“预约我这边查不到”）：打回一次，让它只说自己的。
    const mentions = scripted([
      { action: "reply", text: "好的，明天去合成古寺，预约我这边查不到。" },
      { action: "reply", text: "好的，明天去合成古寺。" },
      { action: "reply", text: "需要预约。" },
    ]);
    const cleaned = await split(mentions.model, "明天去合成古寺，要预约吗");
    expect(cleaned.status === "completed" && cleaned.trace?.hints).toEqual(["next_part_mentioned: another assistant answers the rest right after you; leave that part out of your reply entirely"]);
    expect(cleaned.status === "completed" && cleaned.reply.text).toBe("好的，明天去合成古寺。需要预约。");

    // 不是第一个动作；交给已经跑过的（需求理解先跑了，资料查询想交回去）。
    const late = scripted([
      { action: "search_place", mention: "湖滨", purpose: "visit" },
      { action: "handoff", to: "chat-intake", reason: "x" },
      { action: "reply", text: "好的。" },
    ]);
    const refused = await split(late.model, "后天想去湖滨", { trip });
    expect(refused.status === "completed" && refused.trace?.hints).toEqual(["handoff_not_first: hand off only as your first action; now finish your part and reply"]);
    const back = scripted([
      { action: "reply", text: "好的，明天去合成古寺。" },
      { action: "handoff", to: "chat-intake", reason: "x" },
      { action: "reply", text: "需要预约。" },
    ]);
    const ran = await split(back.model, "明天去合成古寺，要预约吗");
    expect(ran.status === "completed" && ran.trace?.hints).toEqual(["handoff_ran: chat-intake already answered this turn; do your part and reply"]);
  });

  it("refuses an action outside the agent's list, keeps the first part when the second fails, and fails the turn when the first does", async () => {
    // 资料查询想改卡片：拒绝并打回，卡片不动。
    const blocked = scripted([{ action: "update_requirements", patch: { notes: "想去合成古寺" } }, { action: "reply", text: "据说需要预约。" }]);
    const answered = await split(blocked.model, "合成古寺要预约吗");
    expect(answered).toMatchObject({ status: "completed", draftChanged: false });
    expect(answered.status === "completed" && answered.trace?.hints[0]).toMatch(/^action_unavailable: chat-info cannot update_requirements/);

    // 第二个连续给出不合格的输出直到纠错次数用完：保留第一个的结果，说那部分没处理。
    const second = scripted([{ action: "reply", text: "好的，明天去合成古寺" }, "x", "x", "x", "x"]);
    const kept = await split(second.model, "明天去合成古寺，要预约吗");
    expect(kept).toMatchObject({ status: "completed", reply: { text: "好的，明天去合成古寺。另一部分没能处理好，请再说一次。", fallback: true } });

    const first = scripted(["x", "x", "x", "x"]);
    expect(await split(first.model, "明天去合成古寺，要预约吗")).toMatchObject({ status: "failed", code: "invalid_output" });
  });
});

describe("V3.4 prompt isolation (§3.6)", () => {
  const AGENTS: readonly ChatSpecialistId[] = ["chat-intake", "chat-trip", "chat-info", "chat-advice", "chat-companion"];
  const base = { draft: { mode: "day" }, city: { location: "known" }, remaining: { model: 6, searches: 4, weather: 1 } };
  // 代表性的上下文：日常、出游、有已保存行程（含出游）、有偏好和摘要、提问、闲聊和偏好、第二个 Agent。
  const CONTEXTS = [
    base,
    { ...base, draft: { mode: "outing" }, city: { location: "unknown" } },
    { ...base, trip: { outing: {} } },
    { ...base, preferences: ["p1: 不吃辣"], earlier: "之前说过想喝茶" },
    { ...base, remaining: { ...base.remaining, webSearches: 2, knowledge: 1 } },
    { ...base, intent: ["chitchat", "preference"], said: { text: "好的。", asked: false } },
  ] as unknown as ChatDecisionContext[];
  const prompts = (parts: ChatAgentPromptParts) => AGENTS.map((agent) => CONTEXTS.map((context) => chatAgentPrompt(agent, context, parts)));
  /** 每个 Agent 自己的块：换掉它，只有这个 Agent 的提示词可以变。 */
  const OWN: Readonly<Record<string, ChatSpecialistId>> = {
    system: "chat-intake", outing: "chat-intake", cityUnknown: "chat-intake",
    tripRole: "chat-trip", savedTrip: "chat-trip", outingTrip: "chat-trip",
    infoRole: "chat-info", web: "chat-info", knowledge: "chat-info",
    adviceRole: "chat-advice",
    companionRole: "chat-companion", smallTalk: "chat-companion", preference: "chat-companion",
  };

  it("changing one agent's own prompt block leaves every other agent's prompt word for word", () => {
    const before = prompts(CHAT_AGENT_PROMPT_PARTS);
    for (const [key, owner] of Object.entries(OWN)) {
      const after = prompts({ ...CHAT_AGENT_PROMPT_PARTS, [key]: `${CHAT_AGENT_PROMPT_PARTS[key as keyof ChatAgentPromptParts]} (changed)` });
      AGENTS.forEach((agent, index) => {
        if (agent === owner) expect(after[index], key).not.toEqual(before[index]);
        else expect(after[index], `${key} → ${agent}`).toEqual(before[index]);
      });
    }
  });

  it("chat-intake is CHAT_SYSTEM_PROMPT with its own context blocks, without the saved-trip rules", () => {
    // 需求理解实际看到的上下文（没有联网、资料库，intent 至多是建议）：提示词和拆开前一样。
    for (const context of CONTEXTS.slice(0, 4)) {
      const prompt = chatAgentPrompt("chat-intake", context);
      expect(prompt).toBe(chatSystemPrompt({ ...context, trip: undefined }));
      expect(prompt.startsWith(CHAT_SYSTEM_PROMPT)).toBe(true);
    }
    expect(chatAgentPrompt("chat-intake", CONTEXTS[2]!)).not.toContain("Saved trip (V2.5)");
  });
});
