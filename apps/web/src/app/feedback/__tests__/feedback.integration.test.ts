import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  closeSharedJourneyDatabase,
  getSharedJourneyDatabase,
  migrateJourneyDatabase,
  requireSafeTestDatabaseUrl,
} from "@tripquest/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { submitFeedbackApi } from "../api";
import { opsFeedbackGetApi, opsFeedbackPatchApi } from "../../ops/api";

vi.mock("server-only", () => ({}));

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
const describeWithDb = testDatabaseUrl ? describe : describe.skip;

const client = () => getSharedJourneyDatabase();

function jsonRequest(url: string, method: "POST" | "PATCH", body: unknown, sameHost = true) {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      host: "localhost",
      ...(sameHost ? { origin: "http://localhost" } : { origin: "https://evil.example" }),
    },
    body: JSON.stringify(body),
  });
}

describe("feedback API guards and payload validation", () => {
  const normalUser = {
    id: randomUUID(),
    username: "tester",
    displayUsername: "测试用户",
    role: "user" as const,
  };
  const adminUser = {
    id: randomUUID(),
    username: "owner",
    displayUsername: "站长",
    role: "admin" as const,
  };

  it("rejects unauthorized, cross-origin, and malformed feedback submissions before touching DB", async () => {
    const post = (user: typeof normalUser | null, body: unknown, sameHost = true) =>
      submitFeedbackApi(async () => user)(
        jsonRequest("http://localhost/api/feedback", "POST", body, sameHost),
      );

    expect((await post(null, { category: "plan_issue", content: "测试反馈" })).status).toBe(401);
    expect((await post(normalUser, { category: "plan_issue", content: "跨站提交" }, false)).status).toBe(403);
    expect((await post(normalUser, { category: "plan_issue", content: "a" })).status).toBe(400);
    expect((await post(normalUser, { category: "invalid", content: "非法分类测试" })).status).toBe(400);
    expect(
      (
        await post(normalUser, {
          category: "ui_bug",
          content: "非法路径测试",
          pagePath: "https://evil.example/x",
        })
      ).status,
    ).toBe(400);
  });

  it("rejects unauthorized, non-admin, cross-origin, and invalid owner feedback calls", async () => {
    expect(
      (await opsFeedbackGetApi(async () => null)(new Request("http://localhost/api/ops/feedback")))
        .status,
    ).toBe(401);
    expect(
      (
        await opsFeedbackGetApi(async () => normalUser)(
          new Request("http://localhost/api/ops/feedback"),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await opsFeedbackPatchApi(async () => normalUser)(
          jsonRequest("http://localhost/api/ops/feedback", "PATCH", {
            id: randomUUID(),
            status: "resolved",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await opsFeedbackPatchApi(async () => adminUser)(
          jsonRequest(
            "http://localhost/api/ops/feedback",
            "PATCH",
            { id: randomUUID(), status: "resolved" },
            false,
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await opsFeedbackPatchApi(async () => adminUser)(
          jsonRequest("http://localhost/api/ops/feedback", "PATCH", {
            id: "not-a-uuid",
            status: "resolved",
          }),
        )
      ).status,
    ).toBe(400);
  });
});

describeWithDb("user feedback submission and owner triage", () => {
  let adminId = "";
  let aliceId = "";
  const marker = "fb_" + randomUUID().slice(0, 8);

  beforeAll(async () => {
    const url = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    vi.stubEnv("DATABASE_URL", url);
    await migrateJourneyDatabase(client().database, {
      migrationsFolder: resolve("../../packages/db/drizzle"),
    });
    const makeUser = async (role: "admin" | "user", label: string) =>
      (
        await client().pool.query<{ id: string }>(
          "INSERT INTO users (name,email,username,display_username,role) VALUES ($1,$2,$1,$3,$4) RETURNING id",
          [label + "_" + marker, `${label}_${randomUUID()}@test.invalid`, label, role],
        )
      ).rows[0]!.id;
    adminId = await makeUser("admin", "站长测试");
    aliceId = await makeUser("user", "朋友小李");
  });

  afterAll(async () => {
    const ids = [adminId, aliceId].filter(Boolean);
    if (ids.length > 0) {
      await client().pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [ids]);
    }
    vi.unstubAllEnvs();
    await closeSharedJourneyDatabase();
  });

  it("enforces auth, origin, validation, rate limit, owner status updates, privacy, and cascade delete", async () => {
    const adminUser = {
      id: adminId,
      username: "站长测试_" + marker,
      displayUsername: "站长测试",
      role: "admin" as const,
    };
    const normalUser = {
      id: aliceId,
      username: "朋友小李_" + marker,
      displayUsername: "朋友小李",
      role: "user" as const,
    };
    let clock = Date.parse("2026-11-23T03:00:00Z");
    const submitAs = (user: typeof normalUser | null) =>
      submitFeedbackApi(async () => user, () => clock);

    // 1. Auth & origin & validation guards on user submission.
    expect(
      (
        await submitAs(null)(
          jsonRequest("http://localhost/api/feedback", "POST", {
            category: "plan_issue",
            content: "测试反馈内容",
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await submitAs(normalUser)(
          jsonRequest(
            "http://localhost/api/feedback",
            "POST",
            { category: "plan_issue", content: "跨站提交测试" },
            false,
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await submitAs(normalUser)(
          jsonRequest("http://localhost/api/feedback", "POST", {
            category: "plan_issue",
            content: "a",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await submitAs(normalUser)(
          jsonRequest("http://localhost/api/feedback", "POST", {
            category: "plan_issue",
            content: "非法路径测试",
            pagePath: "https://evil.example/x",
          }),
        )
      ).status,
    ).toBe(400);

    // 2. Normal submission strips query string from pagePath and saves context.
    const conversationId = randomUUID();
    const createdRes = await submitAs(normalUser)(
      jsonRequest("http://localhost/api/feedback", "POST", {
        category: "plan_issue",
        content: "西湖边路线稍微有点绕，建议先去书店再去茶馆 " + marker,
        pagePath: `/plan/${conversationId}?secret=1#top`,
        contextLabel: "对话规划 · 日常",
        conversationId,
      }),
    );
    expect(createdRes.status).toBe(201);
    expect(createdRes.headers.get("cache-control")).toBe("private, no-store");
    const created = (await createdRes.json()) as { status: string; id: string };
    expect(created.status).toBe("ok");

    // 3. Rate limit: 3 submissions within 1 minute allowed, 4th rejected with 429.
    for (let i = 0; i < 2; i++) {
      clock += 5_000;
      const ok = await submitAs(normalUser)(
        jsonRequest("http://localhost/api/feedback", "POST", {
          category: "suggestion",
          content: `补充建议 ${i + 1} ${marker}`,
        }),
      );
      expect(ok.status).toBe(201);
    }
    clock += 5_000;
    const limited = await submitAs(normalUser)(
      jsonRequest("http://localhost/api/feedback", "POST", {
        category: "other",
        content: "第四条触发限流 " + marker,
      }),
    );
    expect(limited.status).toBe(429);

    // 4. Owner API auth & origin guards.
    expect(
      (await opsFeedbackGetApi(async () => null)(new Request("http://localhost/api/ops/feedback")))
        .status,
    ).toBe(401);
    expect(
      (
        await opsFeedbackGetApi(async () => normalUser)(
          new Request("http://localhost/api/ops/feedback"),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await opsFeedbackPatchApi(async () => normalUser)(
          jsonRequest("http://localhost/api/ops/feedback", "PATCH", {
            id: created.id,
            status: "resolved",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await opsFeedbackPatchApi(async () => adminUser)(
          jsonRequest(
            "http://localhost/api/ops/feedback",
            "PATCH",
            { id: created.id, status: "resolved" },
            false,
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await opsFeedbackPatchApi(async () => adminUser)(
          jsonRequest("http://localhost/api/ops/feedback", "PATCH", {
            id: randomUUID(),
            status: "resolved",
          }),
        )
      ).status,
    ).toBe(404);

    // 5. Owner reads filtered feedback without leaking email, resolves and reopens.
    const listRes = await opsFeedbackGetApi(async () => adminUser)(
      new Request(`http://localhost/api/ops/feedback?status=open&userId=${aliceId}`),
    );
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).not.toContain("@test.invalid");
    const list = JSON.parse(listText) as {
      openCount: number;
      resolvedCount: number;
      items: Array<{ id: string; pagePath: string | null; contextLabel: string | null; displayUsername: string }>;
    };
    expect(list.openCount).toBe(3);
    expect(list.resolvedCount).toBe(0);
    const first = list.items.find((row) => row.id === created.id)!;
    expect(first.pagePath).toBe(`/plan/${conversationId}`);
    expect(first.contextLabel).toBe("对话规划 · 日常");
    expect(first.displayUsername).toBe("朋友小李");

    const resolvedRes = await opsFeedbackPatchApi(async () => adminUser)(
      jsonRequest("http://localhost/api/ops/feedback", "PATCH", {
        id: created.id,
        status: "resolved",
      }),
    );
    expect(resolvedRes.status).toBe(200);
    const resolvedBody = (await resolvedRes.json()) as { status: string; resolvedAt: string | null };
    expect(resolvedBody.status).toBe("resolved");
    expect(resolvedBody.resolvedAt).toBeTruthy();

    const afterResolve = (await (
      await opsFeedbackGetApi(async () => adminUser)(
        new Request(`http://localhost/api/ops/feedback?status=open&userId=${aliceId}`),
      )
    ).json()) as { openCount: number; resolvedCount: number };
    expect(afterResolve.openCount).toBe(2);
    expect(afterResolve.resolvedCount).toBe(1);

    const reopenRes = await opsFeedbackPatchApi(async () => adminUser)(
      jsonRequest("http://localhost/api/ops/feedback", "PATCH", {
        id: created.id,
        status: "open",
      }),
    );
    expect(reopenRes.status).toBe(200);
    expect(((await reopenRes.json()) as { resolvedAt: string | null }).resolvedAt).toBeNull();

    // 6. Deleting user cascades feedback deletion.
    await client().pool.query("DELETE FROM users WHERE id = $1", [aliceId]);
    const remaining = await client().pool.query("SELECT id FROM user_feedback WHERE user_id = $1", [
      aliceId,
    ]);
    expect(remaining.rows).toHaveLength(0);
  });
});
