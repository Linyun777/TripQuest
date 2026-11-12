import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { emptyDraft } from "@tripquest/application/conversation";
import { createChatRunner } from "@tripquest/agent/chat";
import type { ChatDecisionModel, ChatKnowledgeBase, ChatRunnerDependencies } from "@tripquest/agent/chat";
import type { NearbyPlaceProvider, ProviderEvidence, WeatherProvider, WebSearchProvider } from "@tripquest/providers";
import {
  createAllocateHandler,
  createDraftHandler,
  createLocationHandler,
  createMessageHandler,
  createModeHandler,
  createStartHandler,
} from "../../api/conversations/handlers";
import { dateLabel } from "../conversation-service";
import { MemoryConversations } from "./memory-conversations";
import { asTestUser } from "../../../test-support/users";

// Synthetic places and weather; no provider data.
const NOW = Date.parse("2026-10-13T13:00:00Z");
const evidence: ProviderEvidence = { provider: "amap", sourceKind: "live", attribution: "高德地图", retrievedAt: "2026-10-13T13:00:00Z" };
const weather: WeatherProvider = {
  async getWeatherForecast() {
    return {
      status: "ok",
      data: {
        cityAdcode: "330100",
        reportedAt: "2026-10-13T20:00:00+08:00",
        days: [{ date: "2026-10-14", dayWeather: "小雨", nightWeather: "小雨", highCelsius: 23, lowCelsius: 17, wet: true }],
      },
      evidence,
    };
  },
};


function scripted(decisions: unknown[]): ChatDecisionModel {
  return {
    mode: "scripted",
    provider: "test",
    model: "scripted",
    async decide() {
      return { decision: decisions.shift() ?? { action: "reply", text: "好的" }, usage: null };
    },
  };
}

function setup(
  decisions: unknown[],
  web?: WebSearchProvider,
  knowledge?: ChatKnowledgeBase,
  extra: Partial<ChatRunnerDependencies> = {},
  service: Record<string, unknown> = {},
) {
  const repository = new MemoryConversations();
  const places = {
    async searchPlaces() {
      return {
        status: "ok" as const,
        data: {
          items: [{
            ref: { provider: "amap", externalId: "SYN-SQ" }, name: "合成广场", address: "合成路 1 号", cityAdcode: "330100",
            location: { longitude: 120.1, latitude: 30.2, coordinateSystem: "gcj02" as const },
          }],
          truncated: false,
        },
        evidence,
      };
    },
  };
  const seenPoints: unknown[] = [];
  const nearby: NearbyPlaceProvider = {
    async nearestPlace(point) {
      seenPoints.push(point);
      if (point.longitude < 100) return { status: "failure", failure: { code: "invalid_request", retry: "never", safeMessage: "outside" }, evidence };
      return {
        status: "ok",
        data: {
          place: {
            ref: { provider: "amap", externalId: "SYN-NEAR" }, name: "合成地铁站", address: "合成路 9 号", cityAdcode: "330100",
            location: { longitude: 120.11, latitude: 30.21, coordinateSystem: "gcj02" },
          },
          distanceMeters: 80,
          city: { adcode: "330100", name: "杭州市" },
        },
        evidence,
      };
    },
  };
  const options = {
    user: asTestUser,
    now: () => NOW,
    repository: () => repository,
    // V2.11 出游分配时按编号补查地点（演示地点，不调高德）。
    places: () => ({
      async findPlacesById(ids: readonly string[]) {
        const items = ids.map((externalId) => ({
          ref: { provider: "amap", externalId }, name: "合成广场", cityAdcode: "330100",
          location: { longitude: 120.1, latitude: 30.2, coordinateSystem: "gcj02" as const },
        }));
        return { status: "ok" as const, data: { items, missing: [] }, evidence };
      },
    }),
    weather: () => weather,
    nearby: () => nearby,
    runner: async () => createChatRunner({
      model: scripted(decisions),
      places,
      weather,
      ...(web ? { web } : {}),
      ...(knowledge ? { knowledge } : {}),
      ...extra,
    }),
    ...service,
  };
  return {
    repository,
    start: createStartHandler(options),
    message: createMessageHandler(options),
    draft: createDraftHandler(options),
    allocate: createAllocateHandler(options),
    mode: createModeHandler(options),
    location: createLocationHandler(options),
    seenPoints,
  };
}

const post = (url: string, body: unknown, origin = "http://localhost:3401", method = "POST") => new Request(`http://localhost:3401${url}`, {
  method,
  headers: { origin, host: "localhost:3401", "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("V2.1 conversation API", () => {
  it("starts a conversation, stores the turn, and shows the card with live weather", async () => {
    const { repository, start } = setup([
      { action: "search_place", mention: "合成广场", purpose: "start" },
      { action: "update_requirements", patch: { date: "2026-10-14", startsAt: "09:00", endsAt: "18:00", start: { candidate: "c1" } } },
      { action: "reply", text: "收到！还想去哪里？", ask: true },
    ]);
    const response = await start(post("/api/conversations", { text: "明天 9 点从合成广场出发" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "ok", messageCount: 3, title: "杭州一日 · 10月14日" });
    expect(body.messages.map((message: { kind: string }) => message.kind)).toEqual(["text", "text", "requirements_card"]);
    expect(body.messages[2].card).toMatchObject({
      dateLabel: "10月14日 周三（明天）",
      start: { status: "bound", name: "合成广场" },
      weather: { dayWeather: "小雨", wet: true },
      missing: ["结束地点", "想去的地方或兴趣"],
    });
    // Only IDs and names were stored: no address, coordinates or weather numbers.
    const stored = JSON.stringify([...repository.messages.values()]);
    expect(stored).not.toMatch(/合成路|longitude|latitude|小雨|highCelsius/);
  });

  it("V2.11: a place in another city becomes a notice with 切到出游 before the card, not a stop", async () => {
    const away = {
      ref: { provider: "amap", externalId: "SYN-JL" }, name: "合成锦里", cityAdcode: "510100",
      location: { longitude: 104.06, latitude: 30.66, coordinateSystem: "gcj02" as const },
    };
    const extra: Partial<ChatRunnerDependencies> = {
      places: {
        async searchPlaces(request) {
          return { status: "ok", data: { items: request.scope.kind === "city" ? [] : [away], truncated: false }, evidence };
        },
      },
      cities: { async resolveCity() { return { status: "ok", data: { adcode: "510100", name: "成都市" }, evidence }; } },
    };
    const { start, mode } = setup([
      { action: "search_place", mention: "合成锦里", purpose: "visit" },
      { actions: [{ action: "update_requirements", patch: { date: "2026-10-14" } }, { action: "reply", text: "合成锦里在成都，日常只规划杭州；可以切到出游。" }] },
    ], undefined, undefined, extra);
    const body = await (await start(post("/api/conversations", { text: "明天去合成锦里", city: { adcode: "330100", name: "杭州市" } }))).json();
    expect(body.messages.map((message: { kind: string }) => message.kind)).toEqual(["text", "text", "notice", "requirements_card"]);
    expect(body.messages[2]).toMatchObject({ text: "合成锦里在成都市，日常只规划杭州市。去外地玩可以切到出游。", outing: true });
    expect(body.messages[3].card.visits ?? []).toEqual([]);
    // 点“切到出游”：新的出游卡片带上日期和提到的外地地点。
    const switched = await (await mode(post(`/api/conversations/${body.conversationId}/mode`, {
      mode: "outing", fingerprint: body.messages[3].card.fingerprint,
    }), { params: Promise.resolve({ conversationId: body.conversationId }) })).json();
    expect(switched.messages.map((message: { kind: string }) => message.kind)).toEqual(["notice", "requirements_card"]);
    expect(switched.messages[0].text).toBe("已切到出游，新卡片在下面。带过去了：合成锦里。");
    expect(switched.messages[1].card).toMatchObject({ mode: "outing", outing: { dates: { from: "2026-10-14", to: "2026-10-14" } } });
  });

  it("V2.11: an outing starts from an outing card; an overnight train waits for the user's confirmation on the card", async () => {
    const { start, draft } = setup([
      { actions: [
        { action: "update_requirements", patch: {
          dates: { from: "2026-10-17", to: "2026-10-18" },
          addTransports: [{ day: 1, mode: "train", departAt: "21:30", arriveAt: "06:10" }],
          addInterests: ["逛古镇"],
        } },
        { action: "reply", text: "好的，夜车需要你在卡片上确认。", ask: true },
      ] },
    ]);
    const body = await (await start(post("/api/conversations", { text: "17号坐夜车去云岭", mode: "outing" }))).json();
    expect(body.title).toBe("杭州出游 · 10月17日–18日 · 2 天");
    const card = body.messages.at(-1).card;
    expect(card.mode).toBe("outing");
    expect(card.outing.lodging).toEqual([{ night: 1, place: { status: "missing" }, onBoard: true }]);
    expect(card.missing).toContain("确认第 1 晚在车上过夜");
    const confirmed = await (await draft(post(`/api/conversations/${body.conversationId}/draft`, {
      patch: { confirmOvernight: ["t1"] },
      fingerprint: card.fingerprint,
    }, undefined, "PATCH"), { params: Promise.resolve({ conversationId: body.conversationId }) })).json();
    expect(confirmed.card.outing.transports[0]).toMatchObject({ overnight: true, confirmed: true });
    expect(confirmed.card.missing).not.toContain("确认第 1 晚在车上过夜");
  });

  it("V3.6: empty stations and a missing return are filled by code, said in the reply, and a guessed station can be swapped", async () => {
    const station = (externalId: string, name: string, cityAdcode: string, categoryCode = "150200") => ({
      ref: { provider: "amap", externalId }, name, cityAdcode, categoryCode,
      location: { longitude: 120.1, latitude: 30.2, coordinateSystem: "gcj02" as const },
    });
    const searched: string[] = [];
    const stations = {
      async searchPlaces(request: { query: string; scope: { kind: string; cityAdcode?: string } }) {
        searched.push(`${request.query}@${request.scope.cityAdcode}`);
        const items = request.scope.cityAdcode === "990002"
          ? [station("S-SEA-M", "海合站(地铁站)", "990002", "150500"), station("S-SEA", "海合站", "990002"), station("S-SEA-N", "海合北站", "990002")]
          : [station("S-HOME", "合成东站", "330100")];
        return { status: "ok" as const, data: { items, truncated: false }, evidence };
      },
    };
    const cities = {
      async resolveCity(name: string) {
        return name.startsWith("海合")
          ? { status: "ok" as const, data: { adcode: "990002", name: "海合市" }, evidence }
          : { status: "failure" as const, failure: { code: "invalid_request" as const, retry: "never" as const, safeMessage: "不是城市" }, evidence };
      },
    };
    const { start, draft } = setup([
      { action: "search_place", mention: "合成广场", purpose: "start" },
      { action: "set_city", city: "海合" },
      { action: "update_requirements", patch: {
        dates: { from: "2026-10-17", to: "2026-10-18" },
        start: { candidate: "c1" },
        addTransports: [{ day: 1, mode: "train" }],
        addInterests: ["看海"],
      } },
      { action: "reply", text: "好的，高铁的车站告诉我一下。", ask: true },
    ], undefined, undefined, { cities }, { stations: () => stations });
    const body = await (await start(post("/api/conversations", { text: "17到18号从合成广场坐高铁去海合看海", mode: "outing" }))).json();
    const card = body.messages.at(-1).card;
    expect(card.outing.transports).toMatchObject([
      { day: 1, from: { name: "合成东站" }, to: { name: "海合站" }, suggested: { to: [{ placeId: "S-SEA-N", name: "海合北站" }] } },
      { day: 2, from: { name: "海合站" }, to: { name: "合成东站" }, suggested: { ride: true } },
    ]);
    expect(card.missing).toEqual([]);
    expect(searched).toEqual(["火车站@330100", "火车站@990002"]);
    const reply = body.messages.find((message: { kind: string; role: string }) => message.kind === "text" && message.role === "assistant").text;
    expect(reply).toMatch(/^好的，高铁的车站告诉我一下。\n\n回程按同样的方式估计（第 2 天 海合站 → 合成东站），可改。车站先按合成东站、海合站估计，卡片上可以换。$/);
    const swapped = await (await draft(post(`/api/conversations/${body.conversationId}/draft`, {
      patch: { choose: [{ target: "t1:to", externalId: "S-SEA-N" }] },
      fingerprint: card.fingerprint,
    }, undefined, "PATCH"), { params: Promise.resolve({ conversationId: body.conversationId }) })).json();
    expect(swapped.card.outing.transports[0]).toMatchObject({ to: { name: "海合北站" } });
    expect(swapped.card.outing.transports[0].suggested).toEqual({ from: [] });
  });

  it("V2.11: a complete outing card is split into days, and moving an item keeps the split", async () => {
    const { start, allocate } = setup([
      { action: "search_place", mention: "合成广场", purpose: "start" },
      { actions: [
        { action: "update_requirements", patch: { dates: { from: "2026-10-17", to: "2026-10-18" }, start: { candidate: "c1" }, addInterests: ["逛古镇", "喝茶"] } },
        { action: "reply", text: "好的。" },
      ] },
    ]);
    const body = await (await start(post("/api/conversations", { text: "17到18号从合成广场出发，逛古镇喝茶", mode: "outing" }))).json();
    const card = body.messages.at(-1).card;
    expect(card.missing).toEqual([]);
    const call = (fingerprint: string, move?: unknown) => allocate(post(`/api/conversations/${body.conversationId}/allocate`, { fingerprint, ...(move ? { move } : {}) }), {
      params: Promise.resolve({ conversationId: body.conversationId }),
    });
    const split = await (await call(card.fingerprint)).json();
    expect(split.card.outing.allocation).toMatchObject({ source: "rules", problems: [] });
    expect(split.card.outing.allocation.days.map((day: { items: { name: string }[] }) => day.items.map((item) => item.name))).toEqual([["逛古镇"], ["喝茶"]]);
    const moved = await (await call(split.card.fingerprint, { target: "i2", day: 1 })).json();
    expect(moved.card.outing.allocation.days.map((day: { items: { name: string }[] }) => day.items.map((item) => item.name))).toEqual([["逛古镇", "喝茶"], []]);
  });

  it("V2.11: “开始规划” on a complete card does the card's next step in code, without the model", async () => {
    // 模型只安排了第一轮；后面两句如果走到模型，会拿到缺省的空补丁并失败。
    const { start, message } = setup([
      { action: "search_place", mention: "合成广场", purpose: "start" },
      { actions: [
        { action: "update_requirements", patch: { dates: { from: "2026-10-17", to: "2026-10-18" }, start: { candidate: "c1" }, addInterests: ["逛古镇"] } },
        { action: "reply", text: "好的。" },
      ] },
    ]);
    const body = await (await start(post("/api/conversations", { text: "17到18号从合成广场出发，逛古镇", mode: "outing" }))).json();
    const say = async (text: string, expectedCount: number) => (await message(post(`/api/conversations/${body.conversationId}/messages`, { text, expectedCount }), {
      params: Promise.resolve({ conversationId: body.conversationId }),
    })).json();
    const first = await say("开始规划", body.messageCount);
    expect(first).toMatchObject({ status: "ok", next: "allocate" });
    expect(first.messages.map((item: { kind: string; text?: string }) => item.text)).toEqual(["开始规划", expect.stringContaining("先把地点分到各天")]);
    // 夹着别的要求就不是单纯催下一步，照常交给模型。
    const other = await say("开始规划，再加个喝茶", first.messageCount);
    expect(other.next).toBeUndefined();
  });

  it("V2.10: an automatic title follows the card when the day changes", async () => {
    const { start, message } = setup([
      { action: "update_requirements", patch: { date: "2026-10-14" } },
      { action: "reply", text: "好的。", ask: true },
      { action: "update_requirements", patch: { date: "2026-10-15" } },
      { action: "reply", text: "改成后天了。", ask: true },
    ]);
    const first = await (await start(post("/api/conversations", { text: "明天出去玩", city: { adcode: "330100", name: "杭州市" } }))).json();
    expect(first.title).toBe("杭州一日 · 10月14日");
    const later = await message(post(`/api/conversations/${first.conversationId}/messages`, { text: "改成后天", expectedCount: first.messageCount }), {
      params: Promise.resolve({ conversationId: first.conversationId }),
    });
    expect((await later.json()).title).toBe("杭州一日 · 10月15日");
  });

  it("V2.7: keeps a web answer's sources (URL, title, site, date) and never the page summary", async () => {
    const web: WebSearchProvider = {
      async searchWeb() {
        return {
          status: "ok",
          data: { results: [{ title: "合成博物馆公告", url: "https://example.invalid/notice", site: "合成博物馆", date: "2026-09-01", authority: 3, summary: "需提前一天实名预约" }] },
          evidence,
        };
      },
    };
    const { repository, start } = setup([
      { action: "web_search", query: "合成博物馆 预约" },
      { action: "reply", text: "据合成博物馆9月的公告要提前预约，出发前以官方为准。", sources: ["w1"] },
    ], web);
    const body = await (await start(post("/api/conversations", { text: "合成博物馆要预约吗" }))).json();
    expect(body.messages[1].sources).toEqual([{ kind: "web", url: "https://example.invalid/notice", title: "合成博物馆公告", site: "合成博物馆", date: "2026-09-01" }]);
    expect(JSON.stringify([...repository.messages.values()])).not.toContain("需提前一天实名预约");
  });

  it("V2.8: keeps a knowledge answer's passages by id and title, never their text", async () => {
    const knowledge: ChatKnowledgeBase = {
      async ask() {
        return {
          status: "found",
          passages: [{ chunkId: "causeway:1", documentId: "causeway", title: "合成湖的长堤", headingPath: "合成湖的长堤 > 北堤", text: "北堤由合成知府主持修筑，长约三里。" }],
        };
      },
    };
    const { repository, start } = setup([
      { action: "ask_knowledge", question: "北堤是谁修的" },
      { action: "reply", text: "北堤由合成知府主持修筑。", sources: ["k1"] },
    ], undefined, knowledge);
    const body = await (await start(post("/api/conversations", { text: "北堤是谁修的" }))).json();
    expect(body.messages[1].sources).toEqual([
      { kind: "kb", documentId: "causeway", chunkId: "causeway:1", title: "合成湖的长堤", headingPath: "合成湖的长堤 > 北堤" },
    ]);
    expect(JSON.stringify([...repository.messages.values()])).not.toContain("长约三里");
    expect(body.messages.map((item: { kind: string }) => item.kind)).toEqual(["text", "text"]);
  });

  it("V2.8: streams one line per lookup, then the stored turn, when the page asks for a stream", async () => {
    const knowledge: ChatKnowledgeBase = { async ask() { return { status: "not_found" }; } };
    const { repository, start } = setup([
      { action: "ask_knowledge", question: "北堤是谁修的" },
      { action: "reply", text: "资料库里没有这方面的内容。" },
    ], undefined, knowledge);
    const request = post("/api/conversations", { text: "北堤是谁修的" });
    request.headers.set("accept", "application/x-ndjson, application/json");
    const response = await start(request);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual(["progress", "done"]);
    expect(lines[0].text).toBe("正在查资料库：北堤是谁修的");
    expect(lines[1].reply).toMatchObject({ status: "ok", messageCount: 2, messages: [{ kind: "text" }, { kind: "text", text: "资料库里没有这方面的内容。" }] });
    expect(repository.messages.size).toBe(1);
  });

  it("V2.9: keeps a recommendation's places by id and name only, and leaves the card alone", async () => {
    const { repository, start } = setup([
      { action: "search_place", mention: "广场", purpose: "visit" },
      { action: "reply", text: "可以考虑合成广场，适合随便走走。", places: ["c1"] },
    ]);
    // 页面定位过（V2.10：没定位、也没说从哪出发时，规划类回复要先问出发地）。
    const located = { adcode: "330100", name: "杭州市" };
    const body = await (await start(post("/api/conversations", { text: "推荐个能随便走走的地方", city: located }))).json();
    expect(body.messages.map((message: { kind: string }) => message.kind)).toEqual(["text", "text"]);
    expect(body.messages[1].places).toEqual([{ externalId: "SYN-SQ", name: "合成广场", city: "330100" }]);
    expect(JSON.stringify([...repository.messages.values()])).not.toContain("合成路");
  });

  it("refuses a message based on a stale count, and a cross-site post", async () => {
    const { repository, start, message } = setup([{ action: "reply", text: "你好" }]);
    const { conversationId } = await (await start(post("/api/conversations", { text: "你好" }))).json();
    const stale = await message(post(`/api/conversations/${conversationId}/messages`, { text: "再来", expectedCount: 0 }), {
      params: Promise.resolve({ conversationId }),
    });
    expect(stale.status).toBe(409);
    expect(repository.messages.get(conversationId)).toHaveLength(2);
    const crossSite = await message(post(`/api/conversations/${conversationId}/messages`, { text: "x", expectedCount: 2 }, "https://evil.example"), {
      params: Promise.resolve({ conversationId }),
    });
    expect(crossSite.status).toBe(403);
  });

  it("keeps the draft and says so plainly when the agent fails", async () => {
    const { repository, start } = setup(Array.from({ length: 4 }, () => ({ action: "nonsense" })));
    const body = await (await start(post("/api/conversations", { text: "随便" }))).json();
    expect(body.messages.map((item: { kind: string }) => item.kind)).toEqual(["text", "notice"]);
    expect(body.messages[1].text).toContain("换个说法");
    expect(repository.conversations.get(body.conversationId)?.draft).toEqual(emptyDraft());
  });

  it("edits the live card with the same checks as the chat, refusing stale or contradictory edits", async () => {
    const { repository, start, draft } = setup([
      { action: "search_place", mention: "合成广场", purpose: "start" },
      { action: "update_requirements", patch: { date: "2026-10-14", startsAt: "09:00", endsAt: "18:00", start: { candidate: "c1" } } },
      { action: "reply", text: "好的" },
    ]);
    const first = await (await start(post("/api/conversations", { text: "明天从合成广场出发" }))).json();
    const { conversationId } = first;
    const seen = first.messages[2].card.fingerprint;
    const edit = (patch: unknown, fingerprint = seen) =>
      draft(post(`/api/conversations/${conversationId}/draft`, { patch, fingerprint }, undefined, "PATCH"), {
        params: Promise.resolve({ conversationId }),
      });

    expect(await (await edit({ endsAt: "08:00" })).json()).toEqual({ status: "invalid", code: "window_order" });
    // The card cannot bind a new place by itself; only offered choices can be picked.
    expect((await edit({ end: { candidate: "c1" } })).status).toBe(422);

    const ok = await (await edit({ pace: "relaxed", addInterests: ["喝茶"] })).json();
    expect(ok).toMatchObject({ status: "ok", card: { pace: "relaxed", interests: [{ text: "喝茶" }] } });
    expect(repository.conversations.get(conversationId)?.draft).toMatchObject({ pace: "relaxed" });
    // The card the page held before that edit is now stale.
    expect((await edit({ pace: "standard" })).status).toBe(409);
    expect((await edit({ pace: "standard" }, ok.card.fingerprint)).status).toBe(200);
  });

  it("labels dates relative to today in Hangzhou", () => {
    expect(dateLabel("2026-10-13", NOW)).toBe("10月13日 周二（今天）");
    expect(dateLabel("2026-10-17", NOW)).toBe("10月17日 周六");
  });
});

describe("V2.2 current location and travel on the card", () => {
  it("starts from where the user is: only the nearest place's ID and name are kept", async () => {
    const { repository, start, location, draft, seenPoints } = setup([
      { action: "update_requirements", patch: {
        date: "2026-10-14", startsAt: "09:00", endsAt: "18:00",
        start: { current: true }, end: { current: true }, addInterests: ["看展"],
        travel: { allowed: ["walking", "transit", "taxi"], prefer: "balanced" },
      } },
      { action: "reply", text: "就从你现在的位置出发吧。想怎么出行？我推荐地铁加打车。", ask: true },
    ]);
    const first = await (await start(post("/api/conversations", { text: "明天想去看展" }))).json();
    const { conversationId } = first;
    const card = first.messages.at(-1).card;
    expect(card).toMatchObject({ start: { status: "current" }, missing: ["允许定位（或告诉我出发地点）"] });
    const locate = (body: unknown) => location(post(`/api/conversations/${conversationId}/location`, body), {
      params: Promise.resolve({ conversationId }),
    });

    // Outside Hangzhou: a plain refusal; nothing changes.
    expect(await (await locate({ longitude: 2.35, latitude: 48.85, fingerprint: card.fingerprint })).json())
      .toEqual({ status: "invalid", code: "outside_city" });
    const ok = await (await locate({ longitude: 120.1234567, latitude: 30.2345678, fingerprint: card.fingerprint })).json();
    expect(ok.card).toMatchObject({
      start: { status: "bound", name: "合成地铁站", nearby: true },
      end: { status: "bound", name: "合成地铁站", nearby: true },
      missing: [],
    });
    expect(seenPoints).toHaveLength(2);
    // Neither the device point nor the place's coordinates or address are stored anywhere.
    const stored = JSON.stringify([repository.conversations.get(conversationId), ...repository.messages.values()]);
    expect(stored).not.toMatch(/120\.12|30\.23|120\.11|longitude|latitude|合成路/);
    // A stale card cannot be located over.
    expect((await locate({ longitude: 120.1, latitude: 30.2, fingerprint: card.fingerprint })).status).toBe(409);

    // The card shows the agent's recommendation until the user changes it.
    expect(ok.card.travel).toEqual({ allowed: ["walking", "transit", "taxi"], prefer: "balanced", recommended: false });
    const edited = await (await draft(post(`/api/conversations/${conversationId}/draft`, {
      patch: { travel: { allowed: ["walking", "transit"], prefer: "cheap" } },
      fingerprint: ok.card.fingerprint,
    }, undefined, "PATCH"), { params: Promise.resolve({ conversationId }) })).json();
    expect(edited.card.travel).toMatchObject({ allowed: ["walking", "transit"], prefer: "cheap" });
  });
});
