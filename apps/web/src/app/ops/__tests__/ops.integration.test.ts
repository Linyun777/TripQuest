import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getSharedJourneyDatabase,
  closeSharedJourneyDatabase,
  migrateJourneyDatabase,
  requireSafeTestDatabaseUrl,
  UsageLedger,
  OpsReader,
  pruneBilling,
  readPrices,
  DrizzleJobRepository,
  DrizzleConversationRepository,
  chinaDay,
} from "@tripquest/db";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createChatRunner } from "@tripquest/agent/chat";
import { createConversationService } from "../../plan/conversation-service";
import { inChildRun, withRepair } from "@tripquest/agent/runs";
import { createJsonDecisionTransport } from "@tripquest/agent/live";
import { createDayPlanningProblem } from "@tripquest/application/day-planning";
import {
  PlanningFixtureProvider,
  planningFixtureEvidence,
  planningFixturePlaces,
} from "@tripquest/providers/planning-fixture";
import { createDayPlanningRunner } from "@tripquest/agent/day-planning";
import { createDayLiveModel } from "@tripquest/agent/day-live";
import { money, RunDetails } from "../view";
import { createUserUsage, meteredAmap } from "../../usage/usage";
import { startJob, attachJob } from "../../plan/jobs";
import { traced } from "../../runs/runs";
import { opsApi, opsLimitsApi } from "../api";

vi.mock("server-only", () => ({}));

const price = {
  channel: "default",
  provider: "fixture",
  model: "returned",
  aliases: ["alias"],
  from: "2020-01-01T00:00:00Z",
  currency: "CNY",
  hit: "0.5",
  miss: "2",
  output: "8",
  source: "fixture",
};
const prices = [price, { ...price, model: "second", aliases: [], currency: "USD" }];
const receipt = {
  sent: true,
  provider: "fixture",
  requested: "alias",
  returned: "returned",
  usage: { input: 1000, output: 100, hit: 600, miss: null },
};
const query = new URLSearchParams();
const marker = "SECRET_LOCATION_CHAT_PROVIDER";
const signal = () => new AbortController().signal;

describe.skipIf(!process.env.TEST_DATABASE_URL)("owner billing with synthetic receipts", () => {
  let folder: string;
  let alice: string;
  let bob: string;
  const client = () => getSharedJourneyDatabase();
  const reader = (now = Date.now()) => new OpsReader(client().pool, "fixture-only-secret", now);
  beforeAll(async () => {
    const url = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    vi.stubEnv("DATABASE_URL", url);
    vi.stubEnv("BETTER_AUTH_SECRET", "fixture-only-secret");
    folder = mkdtempSync(join(tmpdir(), "tripquest-cost-"));
    vi.stubEnv("MODEL_BILLING_CHANNEL", "default");
    vi.stubEnv("FIXED_EXPENSE_FILE", "");
    const file = join(folder, "price.json");
    writeFileSync(file, JSON.stringify(prices));
    vi.stubEnv("MODEL_PRICE_FILE", file);
    await migrateJourneyDatabase(client().database, {
      migrationsFolder: resolve("../../packages/db/drizzle"),
    });
    const create = async () =>
      (
        await client().pool.query(
          "INSERT INTO users (name,email,username,role) VALUES ($1,$2,$1,'user') RETURNING id",
          [randomUUID(), randomUUID() + "@test.invalid"],
        )
      ).rows[0].id as string;
    alice = await create();
    bob = await create();
  });
  afterAll(async () => {
    if (alice) await client().pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[alice, bob]]);
    await client().pool.query("DELETE FROM site_usage_limits").catch(() => {});
    await closeSharedJourneyDatabase();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  const modelOptions = (beforeRequest = () => createUserUsage(alice).model!("plan")) => ({
    config: {
      version: 1,
      profiles: {
        fixture: {
          providerId: "fixture",
          adapter: "chat_completions",
          model: "alias",
          baseURL: "https://fixture.invalid",
          apiKeyEnv: "TEST_KEY",
          jsonMode: "json_object",
          thinkingMode: "omit",
          temperature: 0,
          outputTokenLimit: 512,
        },
      },
    },
    profileId: "fixture",
    environment: { TEST_KEY: "fixture-only" },
    beforeRequest,
  });
  const transport = (beforeRequest = () => createUserUsage(alice).model!("plan")) =>
    createJsonDecisionTransport(modelOptions(beforeRequest));
  const response = (content: string) =>
    Response.json({
      id: "fixture",
      model: "returned",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
        prompt_cache_hit_tokens: 600,
      },
    });

  it("shows the failed user task after saving the warning on both start and send", async () => {
    const upstream = vi.fn(async () =>
      Response.json({ status: "0", infocode: "10044", info: "USER_DAILY_QUERY_OVER_LIMIT" }),
    );
    vi.stubGlobal("fetch", upstream);
    const provider = meteredAmap({ key: "fixture", usage: createUserUsage(alice), purpose: "chat" });
    const service = createConversationService({
      userId: alice,
      runner: async () =>
        createChatRunner({
          places: provider,
          weather: provider,
          model: {
            mode: "scripted",
            provider: "fixture",
            model: "fixture",
            async decide() {
              return {
                decision: { action: "search_place", mention: "合成公园", purpose: "start" },
                usage: null,
              };
            },
          },
        }),
    });
    const first = await service.start("合成公园出发，帮我规划一天行程");
    if (first.status !== "ok") throw new Error("expected a saved warning");
    const next = await service.send(first.conversationId, "从合成公园出发", first.messageCount);
    expect(next.status).toBe("ok");
    expect(first.messages).toContainEqual(expect.objectContaining({ kind: "notice" }));
    const roots = (
      await client().pool.query(
        "SELECT id FROM agent_runs WHERE user_id=$1 AND conversation_id=$2 AND trigger='chat_turn'",
        [alice, first.conversationId],
      )
    ).rows;
    expect(roots).toHaveLength(2);
    const failures = (await reader().runs(new URLSearchParams({ status: "failed" }))).runs;
    for (const { id } of roots) {
      expect(failures.some((r) => r.root === id)).toBe(true);
      const detail = await reader().detail("root", id);
      expect(detail?.nodes).toContainEqual(
        expect.objectContaining({ id, status: "failed", outcome: "live_budget" }),
      );
      expect(detail?.steps).toContainEqual(
        expect.objectContaining({
          action: "amap_search",
          code: "quota_exceeded",
          ms: expect.any(Number),
        }),
      );
    }
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("opens a one-day plan from the owner list with its real graph, repair, tool and model steps", async () => {
    const now = () => Date.parse("2026-10-08T10:00:00+08:00");
    const places = planningFixturePlaces();
    const selection = (i: number) => ({ place: places[i]!, evidence: planningFixtureEvidence(now()) });
    const problem = createDayPlanningProblem({
      runId: randomUUID(),
      requirementsFingerprint: "a".repeat(64),
      nowMs: now(),
      requirements: {
        schemaVersion: "planning-requirements.v1",
        cityAdcode: "330100",
        timeZone: "Asia/Shanghai",
        travelMode: "walking",
        date: "2026-10-15",
        window: { startsAt: "10:00", endsAt: "18:00" },
        startPlace: selection(0),
        endPlace: selection(4),
        pace: "standard",
        interests: [],
        visits: [{ place: selection(1), role: "required", stayMinutes: 60 }],
      },
    });
    const fetcher = vi.fn<typeof fetch>();
    for (const decision of [
      { action: "try_itinerary", orderedActivityIds: ["a99"] },
      { action: "try_itinerary", orderedActivityIds: ["a1"] },
      { action: "finish", attemptId: "attempt-1" },
    ])
      fetcher.mockResolvedValueOnce(response(JSON.stringify(decision)));
    vi.stubGlobal("fetch", fetcher);
    const conversation = await new DrizzleConversationRepository(
      client().database,
      alice,
    ).createConversation({ id: randomUUID(), title: marker, now: new Date() });
    const opts = { jobs: () => new DrizzleJobRepository(client().database, alice), userId: alice };
    const job = await startJob(
      opts,
      {
        conversationId: conversation.id,
        kind: "plan",
        requestKey: randomUUID(),
        signal: signal(),
      },
      async (emit, signal) => {
        const runner = createDayPlanningRunner({
          provider: new PlanningFixtureProvider(now),
          now,
          model: createDayLiveModel(modelOptions()),
        });
        const result = await runner.run(problem, {
          signal,
          onProgress: (p) => {
            if (p.detail) emit({ type: "step", step: { text: p.detail } });
          },
        });
        expect(result).toMatchObject({
          status: "completed",
          outcome: "draft",
          counts: { semanticRepairs: 1 },
        });
        emit({ type: "done", outcome: "draft" });
      },
    );
    const [
      {
        job: { jobId },
      },
    ] = (await job.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const entry = (await reader().runs(query)).runs.find((r) => r.id === jobId)!;
    expect(entry.cost).toEqual({ amounts: { CNY: "0.0057" }, pending: 0 });
    const detail = await reader().detail("job", jobId);
    expect(detail?.cost).toEqual(entry.cost);
    expect(detail?.steps.filter((s) => s.event)).toHaveLength(3);
    expect(detail?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "repair", code: "day_unknown_activity" }),
        expect.objectContaining({ kind: "tool_call", action: "try_itinerary" }),
      ]),
    );
    const retried = detail!.steps.filter((step) => step.event)[1]!;
    const repair = detail!.steps.find((step) => step.kind === "repair")!;
    expect(repair.repair).toEqual({
      events: [retried.event],
      cost: { amounts: { CNY: "0.0019" }, pending: 0 },
    });
    expect(
      detail!.steps.find((step) => step.action === "try_itinerary" && step.kind === "tool_call")?.ms,
    ).toEqual(expect.any(Number));
    const markup = renderToStaticMarkup(createElement(RunDetails, { d: detail! }));
    expect(markup).toContain("已计时步骤中最慢");
    const slowest = detail!.steps.filter((step) => step.ms !== null).sort((a, b) => b.ms! - a.ms!)[0]!;
    expect(markup).toContain(
      `已计时步骤中最慢 · <a class="underline" href="#step-${slowest.run}-${slowest.seq}"`,
    );
    expect(markup).toContain(`href="#step-${retried.run}-${retried.seq}"`);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("attributes concurrent child calls, repairs and a new plan to their own jobs; polling is read-only", async () => {
    const conversation = await new DrizzleConversationRepository(
      client().database,
      alice,
    ).createConversation({ id: randomUUID(), title: marker, now: new Date() });
    const opts = { jobs: () => new DrizzleJobRepository(client().database, alice), userId: alice };
    const model = transport();
    const fetcher = vi.fn(async () => response('{"action":"finish"}'));
    vi.stubGlobal("fetch", fetcher);
    let nextStage!: () => void;
    const advance = new Promise<void>((ok) => {
      nextStage = ok;
    });
    let release!: () => void;
    const gate = new Promise<void>((ok) => {
      release = ok;
    });
    const start = async (kind: "outing" | "plan", gated: boolean) =>
      startJob(
        opts,
        {
          conversationId: conversation.id,
          kind,
          requestKey: randomUUID(),
          signal: signal(),
        },
        async (emit) => {
          emit({ type: "step", step: { text: "查地点 " + marker } });
          await Promise.all(
            (gated ? ["day-planner", "outing-repair"] : ["day-planner"]).map((agent) =>
              inChildRun(
                agent,
                {},
                async (run) => {
                  const request = () => model.request(marker, marker, signal());
                  if (agent === "outing-repair") {
                    await withRepair("try_move", "trial_change", () =>
                      inChildRun("day-planner", {}, request, () => ({ status: "ok" })),
                    );
                  } else {
                    run?.step("tool_call", "route", { location: marker });
                    await request();
                  }
                },
                () => ({ status: "ok" }),
              ),
            ),
          );
          if (gated) await advance;
          emit({ type: "step", step: { text: "检查方案 " + marker } });
          if (gated) await gate;
          emit({ type: kind === "outing" ? "outing_done" : "done", outcome: "draft" });
        },
      );
    const a = await start("outing", true);
    const started = await opts.jobs().latest(conversation.id, new Date(), new Date(Date.now() - 30_000));
    let active: Awaited<ReturnType<OpsReader["runs"]>>["runs"][number] | undefined;
    try {
      await vi.waitFor(
        async () => {
          active = (await reader().runs(query)).runs.find(
            (r) => r.id === started?.id && r.status === "running",
          );
          expect(active?.phase).toBe("查询地点");
          expect(active?.cost.amounts.CNY).toBe("0.0038");
        },
        { timeout: 5000 },
      );
      nextStage();
      await vi.waitFor(
        async () => {
          const run = await reader().detail("job", active!.id);
          expect(run?.phase).toBe("检查方案");
          expect(run?.status).toBe("running");
        },
        { timeout: 5000 },
      );
      const reconnect = await attachJob(opts, conversation.id);
      expect(reconnect.status).toBe(200);
    } finally {
      nextStage();
      release();
    }
    await a.text();
    const aDetail = await reader().detail("job", active!.id);
    expect(aDetail?.cost.amounts.CNY).toBe("0.0038");
    expect(aDetail?.steps.filter((s) => s.event)).toHaveLength(2);
    expect(aDetail?.nodes.filter((n) => n.parent)).toHaveLength(3);
    const trial = aDetail!.steps.find((s) => s.kind === "repair")!;
    expect(trial.repair?.cost).toEqual({ amounts: { CNY: "0.0019" }, pending: 0 });
    const child = aDetail!.nodes.find((n) => n.parent === trial.run)!;
    expect(trial.repair?.events).toEqual(
      aDetail!.steps.filter((s) => s.run === child.id && s.event).map((s) => s.event),
    );
    expect(JSON.stringify(aDetail)).not.toContain(marker);
    const b = await start("outing", false);
    const [
      {
        job: { jobId: bId },
      },
    ] = (await b.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const list = (await reader().runs(query)).runs;
    const bRun = list.find((r) => r.id === bId)!;
    expect(bRun.root).not.toBe(active!.root);
    expect(bRun.cost.amounts.CNY).toBe("0.0019");
    expect((await reader().detail("root", bRun.root!))?.cost).toEqual(bRun.cost);
    const ledger = new UsageLedger(client().pool, alice, {}, Date.now, () => active!.root);
    const grouped = await reader().usage(new URLSearchParams({ kind: "outing", model: "returned" }));
    expect(grouped.groups.find((g) => g.currency === "CNY")).toMatchObject({
      roots: 2,
      samples: 2,
      average: "0.00285",
    });
    const id = aDetail!.calls[0]!.id;
    await Promise.all(
      [1, 2].map(() => ledger.settleModel({ id, at: new Date() }, receipt, prices, "default")),
    );
    const uncertain = await ledger.reserveEvent("model", "model", "plan", active!.root!);
    await ledger.settleModel(uncertain, { ...receipt, usage: null }, prices, "default");
    expect((await reader().detail("job", active!.id))?.cost).toEqual({
      amounts: { CNY: "0.0038" },
      pending: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("separates cached price versions, currencies, real zero, missing prices and midnight", async () => {
    const a = Date.parse("2026-10-30T15:59:59Z");
    const b = a + 2000;
    const root = randomUUID();
    const versions = [...prices, { ...price, from: "2026-10-30T16:00:00Z", hit: "1" }];
    for (const [i, model] of ["returned", "returned", "second", "unpriced", "second"].entries()) {
      const ledger = new UsageLedger(
        client().pool,
        bob,
        {},
        () => (i === 0 ? a : b),
        () => root,
      );
      const event = await ledger.reserveEvent("model", "model", "plan", root);
      const bill = {
        ...receipt,
        returned: model,
        ...(i === 4 ? { usage: { input: 0, output: 0, hit: 0, miss: 0 } } : {}),
      };
      await Promise.all(
        Array.from({ length: i === 0 ? 2 : 1 }, () =>
          ledger.settleModel(event, bill, versions, "default"),
        ),
      );
    }
    const filtered = await reader(b).runs(new URLSearchParams({ day: chinaDay(a), model: "returned" }));
    const detail = await reader(b).detail("root", root, chinaDay(a));
    expect(filtered.runs.find((r) => r.root === root)?.cost).toEqual(detail?.cost);
    expect(detail?.cost).toEqual({ amounts: { CNY: "0.0041", USD: "0.0019" }, pending: 1 });
    expect(detail?.selectedDay).toEqual({ amounts: { CNY: "0.0019" }, pending: 0 });
    expect(detail?.calls.some((c) => c.amount !== null && Number(c.amount) === 0)).toBe(true);
    const daily = await reader(b).usage(query);
    expect(
      daily.groups
        .filter((g) => g.currency === "CNY" || g.currency === "USD")
        .every((g) => g.samples === 0 && g.pendingRoots === 1),
    ).toBe(true);
    expect(daily.today.amounts.CNY).toBe("0.0022");
    expect(daily.month.amounts.CNY).toBe("0.0041");
    // Use a historical month so the cleanup cannot age other suites' recent receipts.
    const oldDate = Date.parse("1900-10-01T04:00:00Z");
    const oldLedger = new UsageLedger(
      client().pool,
      bob,
      {},
      () => oldDate,
      () => root,
    );
    const oldEvent = await oldLedger.reserveEvent("model", "model", "plan", root);
    await oldLedger.settleModel(
      oldEvent,
      receipt,
      prices.map((p) => ({ ...p, from: "1900-01-01T00:00:00Z" })),
      "default",
    );
    const oldRow = async () =>
      (
        await client().pool.query(
          "SELECT meter_status,child_run_id,amount,run_id FROM usage_events WHERE id=$1",
          [oldEvent.id],
        )
      ).rows[0];
    await pruneBilling(client().pool, Date.parse("1900-10-31T04:00:00Z"));
    expect((await oldRow()).meter_status).toBe("estimated");
    await pruneBilling(client().pool, Date.parse("1900-11-01T04:00:00Z"));
    expect(await oldRow()).toMatchObject({
      meter_status: null,
      child_run_id: null,
      amount: null,
      run_id: root,
    });
    expect((await reader(b).detail("root", root))?.cost).toEqual(detail?.cost);
    expect(money({ amounts: {}, pending: 0 })).toBe("暂无计价样本");
    expect(money({ amounts: {}, pending: 1 })).toContain("费用待核对");
    expect(money({ amounts: { CNY: "0" }, pending: 0 })).toBe("CNY 0");
    await client().pool.query("DELETE FROM users WHERE id=$1", [bob]);
    expect(await reader(b).detail("root", root)).toBeNull();
    expect(
      (await client().pool.query("SELECT id FROM usage_events WHERE user_id=$1", [bob])).rows,
    ).toHaveLength(0);
  });

  it("reads a stale heartbeat without interrupting the job and keeps the last stage after interruption", async () => {
    const store = new DrizzleConversationRepository(client().database, alice);
    const conversation = await store.createConversation({
      id: randomUUID(),
      title: marker,
      now: new Date(),
    });
    const jobs = new DrizzleJobRepository(client().database, alice);
    const old = new Date(Date.now() - 60_000);
    const id = randomUUID();
    await jobs.begin({
      id,
      conversationId: conversation.id,
      kind: "plan",
      planned: [],
      requestKey: randomUUID(),
      now: old,
      staleBefore: old,
    });
    await jobs.progress(id, { step: "检查方案 " + marker }, old);
    expect(await reader().detail("job", id)).toMatchObject({
      stale: true,
      status: "running",
      root: null,
      phase: "检查方案",
    });
    expect((await jobs.get(id))?.status).toBe("running");
    await jobs.finish(id, "interrupted", new Date());
    expect(await reader().detail("job", id)).toMatchObject({ status: "interrupted", phase: "检查方案" });
  });

  it("checks session and role before every read, including detail IDs", async () => {
    const request = new Request("http://localhost/api/ops/runs?type=root");
    for (const resource of ["usage", "runs", "detail"] as const) {
      expect((await opsApi(resource, async () => null)(request, randomUUID())).status).toBe(401);
      const user = { id: alice, username: marker, displayUsername: marker, role: "user" as const };
      expect((await opsApi(resource, async () => user)(request, randomUUID())).status).toBe(403);
      const reply = await opsApi(resource, async () => ({ ...user, role: "admin" }))(
        request,
        randomUUID(),
      );
      expect(reply.status).toBe(resource === "detail" ? 404 : 200);
      expect(reply.headers.get("cache-control")).toBe("private, no-store");
      expect(await reply.text()).not.toContain(marker);
    }
  });

  it("settles malformed decisions and keeps uncertain attempts pending without retrying HTTP", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await traced({ userId: alice, trigger: "chat_turn" }, async (run) => {
      const usage = createUserUsage(alice);
      const cancel = new AbortController();
      const blocked = transport(async () => {
        const event = await usage.model!("plan");
        cancel.abort();
        return event;
      });
      await expect(blocked.request("", "", cancel.signal)).rejects.toThrow();
      fetcher.mockRejectedValueOnce(new Error("timeout"));
      await expect(transport().request("", "", signal())).rejects.toThrow();
      fetcher.mockResolvedValueOnce(response("invalid"));
      await expect(transport().request("", "", signal())).rejects.toThrow();
      fetcher.mockResolvedValueOnce(response("{}"));
      const failedWrite = transport(async () => {
        const event = await usage.model!("plan");
        return {
          ...event,
          settle: async () => {
            throw new Error(marker);
          },
        };
      });
      await failedWrite.request("", "", signal());
      return run.rootId;
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain(marker);
    warning.mockRestore();
    const d = await reader().detail("root", root);
    expect(d?.cost).toEqual({ amounts: { CNY: "0.0019" }, pending: 2 });
    expect(d).toMatchObject({ kind: "chat_turn", status: "ok" });
    expect(d?.calls.map((c) => c.status).sort()).toEqual(["estimated", "reserved", "unknown", "unsent"]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const file = join(folder, "bad.json");
    writeFileSync(file, JSON.stringify([price, price]));
    expect(() => readPrices(file)).toThrow();
  });

  it("observes per-user usage/runs, updates site & user quotas with auth/origin guards, and attributes limit scope", async () => {
    const carol = (
      await client().pool.query(
        "INSERT INTO users (name,email,username,display_username,role) VALUES ($1,$2,$1,$3,'user') RETURNING id",
        ["carol_" + randomUUID().slice(0, 8), randomUUID() + "@test.invalid", "小卡"],
      )
    ).rows[0].id as string;
    const adminUser = { id: alice, username: "admin", displayUsername: "站长", role: "admin" as const };
    const normalUser = { id: carol, username: "carol", displayUsername: "小卡", role: "user" as const };
    const patchRequest = (body: unknown, sameHost = true) =>
      new Request("http://localhost/api/ops/limits", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          ...(sameHost ? { origin: "http://localhost" } : { origin: "https://evil.example" }),
        },
        body: JSON.stringify(body),
      });

    try {
      // Auth & same-origin guards on /api/ops/users and /api/ops/limits.
      expect((await opsApi("users", async () => null)(new Request("http://localhost/api/ops/users"))).status).toBe(401);
      expect((await opsApi("users", async () => normalUser)(new Request("http://localhost/api/ops/users"))).status).toBe(403);
      expect((await opsLimitsApi(async () => null)(patchRequest({ scope: "site", updates: [{ category: "model", limit: 10 }] }))).status).toBe(401);
      expect((await opsLimitsApi(async () => normalUser)(patchRequest({ scope: "site", updates: [{ category: "model", limit: 10 }] }))).status).toBe(403);
      expect((await opsLimitsApi(async () => adminUser)(patchRequest({ scope: "site", updates: [{ category: "model", limit: 10 }] }, false))).status).toBe(403);
      expect((await opsLimitsApi(async () => adminUser)(patchRequest({ scope: "site", updates: [{ category: "model", limit: -1 }] }))).status).toBe(400);
      expect((await opsLimitsApi(async () => adminUser)(patchRequest({ scope: "user", userId: randomUUID(), updates: [{ category: "model", limit: 10 }] }))).status).toBe(404);

      // Update carol's personal model limit to 5 and site model limit to 2 (so site caps carol).
      const setUserRes = await opsLimitsApi(async () => adminUser)(
        patchRequest({ scope: "user", userId: carol, updates: [{ category: "model", limit: 5 }] }),
      );
      expect(setUserRes.status).toBe(200);
      expect(setUserRes.headers.get("cache-control")).toBe("private, no-store");

      const setSiteRes = await opsLimitsApi(async () => adminUser)(
        patchRequest({ scope: "site", updates: [{ category: "model", limit: 2 }] }),
      );
      expect(setSiteRes.status).toBe(200);
      const afterLimits = (await setSiteRes.json()) as Awaited<ReturnType<OpsReader["users"]>>;
      expect(afterLimits.site.find((item) => item.category === "model")).toMatchObject({
        limit: 2,
        customLimit: 2,
      });
      const carolSummary = afterLimits.users.find((item) => item.id === carol)!;
      expect(carolSummary.displayUsername).toBe("小卡");
      expect(carolSummary.quotas.find((q) => q.category === "model")).toMatchObject({
        limit: 5,
        customLimit: 5,
        cappedBySite: true,
      });
      // Never leak email or conversation marker.
      const usersReply = await opsApi("users", async () => adminUser)(new Request("http://localhost/api/ops/users"));
      const usersText = await usersReply.text();
      expect(usersReply.status).toBe(200);
      expect(usersText).not.toContain("@test.invalid");
      expect(usersText).not.toContain(marker);

      // Trigger a site_limit rejection for carol (site limit set to 0) and verify trace attribution.
      await opsLimitsApi(async () => adminUser)(
        patchRequest({ scope: "site", updates: [{ category: "model", limit: 0 }] }),
      );
      const siteBlockedRoot = await traced({ userId: carol, trigger: "chat_turn" }, async (run) => {
        await expect(createUserUsage(carol).model!("plan")).rejects.toMatchObject({ scope: "site" });
        return run.rootId;
      });
      const siteDetail = await reader().detail("root", siteBlockedRoot);
      expect(siteDetail?.steps).toContainEqual(
        expect.objectContaining({ kind: "check", action: "quota", code: "site_limit" }),
      );
      expect(renderToStaticMarkup(createElement(RunDetails, { d: siteDetail! }))).toContain("触发全站日上限");

      // Raise site limit and set carol's personal limit to 0: verify user_limit attribution & per-user run isolation.
      await opsLimitsApi(async () => adminUser)(
        patchRequest({ scope: "site", updates: [{ category: "model", limit: 500 }] }),
      );
      await opsLimitsApi(async () => adminUser)(
        patchRequest({ scope: "user", userId: carol, updates: [{ category: "model", limit: 0 }] }),
      );
      const userBlockedRoot = await traced({ userId: carol, trigger: "chat_turn" }, async (run) => {
        await expect(createUserUsage(carol).model!("plan")).rejects.toMatchObject({ scope: "user" });
        return run.rootId;
      });
      const userDetail = await reader().detail("root", userBlockedRoot);
      expect(userDetail?.steps).toContainEqual(
        expect.objectContaining({ kind: "check", action: "quota", code: "user_limit" }),
      );
      expect(renderToStaticMarkup(createElement(RunDetails, { d: userDetail! }))).toContain("触发个人日上限");

      // Per-user filtering on runs & usage isolates carol from alice.
      const carolRuns = await reader().runs(new URLSearchParams({ userId: carol }));
      expect(carolRuns.runs.map((r) => r.root).sort()).toEqual([siteBlockedRoot, userBlockedRoot].sort());
      expect((await reader().runs(new URLSearchParams({ userId: "not-a-uuid" }))).runs).toEqual([]);
      const carolUsage = await reader().usage(new URLSearchParams({ userId: carol }));
      expect(carolUsage.counts.model).toBe(0);

      // Reset overrides back to default via limit: null.
      const resetSite = await opsLimitsApi(async () => adminUser)(
        patchRequest({ scope: "site", updates: [{ category: "model", limit: null }] }),
      );
      expect(resetSite.status).toBe(200);
      const resetUser = await opsLimitsApi(async () => adminUser)(
        patchRequest({ scope: "user", userId: carol, updates: [{ category: "model", limit: null }] }),
      );
      expect(resetUser.status).toBe(200);
      const restored = (await resetUser.json()) as Awaited<ReturnType<OpsReader["users"]>>;
      expect(restored.site.find((item) => item.category === "model")?.customLimit).toBeNull();
      expect(
        restored.users.find((item) => item.id === carol)?.quotas.find((q) => q.category === "model")?.customLimit,
      ).toBeNull();
    } finally {
      await client().pool.query("DELETE FROM site_usage_limits");
      await client().pool.query("DELETE FROM users WHERE id=$1", [carol]);
    }
  });
});
