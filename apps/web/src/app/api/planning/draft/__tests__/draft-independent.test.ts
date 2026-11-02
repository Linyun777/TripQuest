import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  DAY_STREAM_TOTAL_BYTES,
  dayStreamEventSchema,
  type DayPlanningResult,
} from "@tripquest/application/day-planning";
import {
  PlanningFixtureProvider,
  planningFixtureEvidence,
  planningFixturePlaces,
} from "@tripquest/providers/planning-fixture";
import { createGenerationService } from "../../../../planning/new/generation-service";
import { issuePlaceToken } from "../../../../planning/new/place-token";
import { createDraftHandler, DRAFT_BODY_LIMIT } from "../draft-handler";
import { asTestUser } from "../../../../../test-support/users";

const now = () => Date.parse("2026-10-08T02:00:00Z");
const secret = "independent-stream-secret-0123456789abcdef";
const environment: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  PLANNING_PLACE_SOURCE: "fixture",
  PLANNING_PLACE_TOKEN_SECRET: secret,
  PLANNING_GENERATION_ENABLED: "true",
  PLANNING_MODEL_MODE: "scripted",
};
const [start, , , , end] = planningFixturePlaces();
const token = (place: typeof start) => issuePlaceToken(
  { place, evidence: planningFixtureEvidence(now()) }, secret, "fixture", now(),
);
const submission = {
  schemaVersion: "planning-requirements.v1",
  cityAdcode: "330100",
  timeZone: "Asia/Shanghai",
  travelMode: "walking",
  date: "2026-10-15",
  window: { startsAt: "10:00", endsAt: "18:00" },
  startPlace: token(start),
  endPlace: token(end),
  interests: ["culture"],
  pace: "standard",
  visits: [],
};
function post(body: BodyInit) {
  return new Request("http://localhost:3300/api/planning/draft", {
    method: "POST",
    headers: {
      origin: "http://localhost:3300",
      host: "localhost:3300",
      "content-type": "application/json",
    },
    body,
    duplex: "half",
  } as RequestInit);
}
afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("independent stream boundaries", () => {
  it("propagates reader cancellation and never schedules routes after a late search result", async () => {
    const provider = new PlanningFixtureProvider(now);
    const actualSearch = provider.searchPlaces.bind(provider);
    const entered = deferred<void>();
    const release = deferred<void>();
    const dependencySettled = deferred<void>();
    const runnerSettled = deferred<DayPlanningResult>();
    let receivedSignal: AbortSignal | undefined;
    const search = vi.spyOn(provider, "searchPlaces").mockImplementation(async (request, options) => {
      receivedSignal = options?.signal;
      entered.resolve();
      await release.promise; // This synthetic dependency intentionally ignores cancellation.
      try {
        return await actualSearch(request);
      } finally {
        dependencySettled.resolve();
      }
    });
    const routes = vi.spyOn(provider, "findRoutes");
    const service = createGenerationService({ environment, now, provider });
    const handler = createDraftHandler(() => ({
      async prepare(body) {
        const prepared = await service.prepare(body);
        if (prepared.status !== "ready") return prepared;
        return {
          ...prepared,
          runner: {
            async run(problem, options) {
              const result = await prepared.runner.run(problem, options);
              runnerSettled.resolve(result);
              return result;
            },
          },
        };
      },
    }),
      undefined,
      undefined,
      asTestUser,
    );
    const response = await handler(post(JSON.stringify(submission)));
    const reader = response.body!.getReader();
    try {
      await entered.promise;
      await reader.cancel();
      expect(receivedSignal?.aborted).toBe(true);
      expect(await runnerSettled.promise).toMatchObject({ status: "cancelled" });
    } finally {
      release.resolve();
    }
    await dependencySettled.promise;
    expect(search).toHaveBeenCalledTimes(1);
    expect(routes).not.toHaveBeenCalled();
  });

  it("preserves one terminal event and consecutive sequence numbers under stream pressure", async () => {
    const service = createGenerationService({ environment, now });
    const handler = createDraftHandler(() => ({
      async prepare(body) {
        const prepared = await service.prepare(body);
        if (prepared.status !== "ready") return prepared;
        return {
          ...prepared,
          runner: {
            async run(problem, { onProgress }) {
              const counts = { model: 0, searches: 0, tries: 0, routes: 0, semanticRepairs: 0 };
              for (let index = 0; index < 6000; index += 1) {
                onProgress({ phase: "preparing", counts });
              }
              return {
                runId: problem.runId,
                status: "failed",
                code: "timeout",
                counts,
                elapsedMs: 0,
                usage: null,
              };
            },
          },
        };
      },
    }),
      undefined,
      undefined,
      asTestUser,
    );
    const response = await handler(post(JSON.stringify(submission)));
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeLessThanOrEqual(DAY_STREAM_TOTAL_BYTES);
    const lines = new TextDecoder().decode(bytes).trimEnd().split("\n");
    const events = lines.map((line) => dayStreamEventSchema.parse(JSON.parse(line)));
    expect(events.length).toBeLessThan(6002);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
    expect(events.filter((event) => event.type === "result")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "result", result: { status: "failed", code: "timeout" } });
  });

  it("counts UTF-8 bytes and rejects malformed encoding before preparing a run", async () => {
    const prepare = vi.fn(async () => ({ status: "unavailable" as const, message: "synthetic" }));
    const handler = createDraftHandler(() => ({ prepare }), undefined, undefined, asTestUser);
    const oversized = new TextEncoder().encode("旅".repeat(Math.ceil(DRAFT_BODY_LIMIT / 3)));
    expect((await handler(post(oversized))).status).toBe(413);
    expect((await handler(post(new Uint8Array([0xc3, 0x28])))).status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });
});
