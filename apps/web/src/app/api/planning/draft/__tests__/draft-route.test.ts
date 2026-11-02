import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { dayStreamEventSchema, type DayStreamEvent } from "@tripquest/application/day-planning";
import {
  PlanningFixtureProvider,
  planningFixtureEvidence,
  planningFixturePlaces,
} from "@tripquest/providers/planning-fixture";
import type { RouteRequest } from "@tripquest/providers";
import { createGenerationService } from "../../../../planning/new/generation-service";
import { readPlanningConfig } from "../../../../planning/new/planning-config";
import { createPlanningService } from "../../../../planning/new/planning-service";
import { issuePlaceToken } from "../../../../planning/new/place-token";
import { createDraftHandler, DRAFT_BODY_LIMIT } from "../draft-handler";
import { asTestUser } from "../../../../../test-support/users";

const ORIGIN = "http://127.0.0.1:3200";
const secret = "draft-route-test-secret-0123456789abcdef";
const t0 = Date.parse("2026-10-08T02:00:00Z");
const fixtureEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  PLANNING_PLACE_SOURCE: "fixture",
  PLANNING_PLACE_TOKEN_SECRET: secret,
  PLANNING_GENERATION_ENABLED: "true",
  PLANNING_MODEL_MODE: "scripted",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

async function token(name: string, now = t0): Promise<string> {
  const config = readPlanningConfig(fixtureEnv);
  const reply = await createPlanningService({ config, now: () => now }).search(name);
  if (reply.status !== "ok") throw new Error("fixture search failed");
  const item = reply.items.find((candidate) => candidate.selection.place.name === name);
  if (!item) throw new Error(`no fixture place ${name}`);
  return item.token;
}

async function submission(visits: unknown[] = [], interests = ["culture", "nature", "food"]) {
  return {
    schemaVersion: "planning-requirements.v1",
    cityAdcode: "330100",
    timeZone: "Asia/Shanghai",
    travelMode: "walking",
    date: "2026-10-15",
    window: { startsAt: "10:00", endsAt: "18:00" },
    startPlace: await token("演示起点"),
    endPlace: await token("演示餐饮终点"),
    interests,
    pace: "standard",
    visits,
  };
}

function post(body: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal) {
  // Next may present request.url as localhost; the check uses the browser's Host header.
  return new Request("http://localhost:3200/api/planning/draft", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      host: new URL(ORIGIN).host,
      ...headers,
    },
    body,
    signal,
    duplex: "half",
  } as RequestInit);
}

function handler(options: Parameters<typeof createGenerationService>[0] = {}) {
  return createDraftHandler(() =>
    createGenerationService({ environment: fixtureEnv, now: () => t0 + 1000, ...options }),
    undefined,
    undefined,
    asTestUser,
  );
}

async function events(response: Response): Promise<DayStreamEvent[]> {
  const lines = (await response.text()).split("\n");
  expect(lines.pop(), "stream ends with a newline").toBe("");
  return lines.map((line) => dayStreamEventSchema.parse(JSON.parse(line)));
}

describe("POST /api/planning/draft", () => {
  it("streams one ordered fixture + scripted run from an empty activity list without external requests", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const response = await handler()(post(JSON.stringify(await submission())));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/x-ndjson/);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const stream = await events(response);
    expect(stream.map((event) => event.sequence)).toEqual(stream.map((_, index) => index));
    expect(stream[0].type).toBe("started");
    expect(new Set(stream.map((event) => event.runId)).size).toBe(1);
    expect(stream.filter((event) => event.type === "result")).toHaveLength(1);
    const last = stream.at(-1);
    if (last?.type !== "result") throw new Error("missing terminal result");
    const result = last.result;
    if (result.status !== "completed" || result.outcome !== "draft") {
      throw new Error(JSON.stringify(result));
    }
    expect(result.draft.activities.length).toBeGreaterThanOrEqual(2);
    expect(result.draft.activities.every((a) => a.role === "discovered")).toBe(true);
    expect(result.draft.verification).toBe("pending");
    expect(result.counts.searches).toBeGreaterThan(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses cross-site, non-JSON, oversized, malformed and unavailable requests before any stream", async () => {
    const body = JSON.stringify(await submission());
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const cases: [string, Request, number, ReturnType<typeof handler>?][] = [
      ["other origin", post(body, { origin: "https://example.com" }), 403],
      ["origin and host disagree", post(body, { host: "localhost:3200" }), 403],
      ["cross-site fetch metadata", post(body, { "sec-fetch-site": "cross-site" }), 403],
      ["no origin information", post(body, { origin: "" }), 403],
      ["text body", post(body, { "content-type": "text/plain" }), 415],
      ["malformed JSON", post("{"), 400],
      [
        "body larger than 64 KiB without content-length",
        post(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(DRAFT_BODY_LIMIT + 1).fill(32));
              controller.close();
            },
          }),
        ),
        413,
      ],
      [
        "generation disabled",
        post(body),
        503,
        handler({ environment: { ...fixtureEnv, PLANNING_GENERATION_ENABLED: "false" } }),
      ],
      [
        "production with a live model",
        post(body),
        503,
        handler({
          environment: {
            ...fixtureEnv,
            NODE_ENV: "production",
            PLANNING_MODEL_MODE: "live",
            PLANNING_LIVE_ROUND: "developer",
            AGENT_LIVE_ENABLED: "true",
            AGENT_MODEL_PROFILE: "deepseek-flash",
          },
        }),
      ],
    ];
    for (const [label, request, status, custom] of cases) {
      const response = await (custom ?? handler())(request);
      expect(response.status, label).toBe(status);
      expect(response.headers.get("content-type"), label).toMatch(/^application\/json/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rechecks place tokens and the fixture dataset version before starting", async () => {
    const body = await submission();
    const expired = await handler({ now: () => t0 + 30 * 60 * 1000 })(post(JSON.stringify(body)));
    expect(expired.status).toBe(422);
    expect(Object.keys((await expired.json()).fieldErrors).sort()).toEqual(["endPlace", "startPlace"]);

    const [start, , , , end] = planningFixturePlaces();
    const oldEvidence = { ...planningFixtureEvidence(t0), datasetVersion: "planning-fixture.v1" };
    const sign = (place: typeof start) =>
      issuePlaceToken({ place, evidence: oldEvidence }, secret, "fixture", t0);
    const stale = await handler()(
      post(JSON.stringify({ ...body, startPlace: sign(start), endPlace: sign(end) })),
    );
    expect(stale.status).toBe(422);
    expect(JSON.stringify(await stale.json())).toContain("重新搜索");
  });

  it("stops scheduling new tool calls once the request is aborted", async () => {
    const abort = new AbortController();
    const provider = new PlanningFixtureProvider(() => t0 + 1000);
    const routes: RouteRequest[] = [];
    const findRoutes = provider.findRoutes.bind(provider);
    provider.findRoutes = async (request, options) => {
      routes.push(request);
      abort.abort();
      return findRoutes(request, options);
    };
    const visits = [{ token: await token("演示博物馆"), role: "required", stayMinutes: 60 }];
    const response = await handler({ provider })(
      post(JSON.stringify(await submission(visits, [])), {}, abort.signal),
    );
    const stream = await events(response);
    const last = stream.at(-1);
    expect(last?.type === "result" && last.result.status).toBe("cancelled");
    expect(routes).toHaveLength(1);
  });
});
