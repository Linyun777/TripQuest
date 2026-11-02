import { describe, expect, it, vi } from "vitest";
import { TEST_USER } from "../../../../../test-support/users";

// V2.12：动作先取当前用户；测试里固定一个用户（会话本身由 Better Auth 管，不在这里测）。
vi.mock("server-only", () => ({}));
vi.mock("../../../../auth/session", () => ({ pageUser: async () => TEST_USER }));
import { previewJourneyAction } from "../actions";
import { initialPreviewFormState } from "../form-state";

describe("S3.3 preview Server Action boundary", () => {
  it("rejects forged form fields before opening a database connection", async () => {
    const data = new FormData();
    data.set("basePlanVersion", "1");
    data.set("observedAt", "14:30");
    data.set("earliestResumeAt", "15:30");
    data.set("location", "unknown");
    data.set("placeId", "forged");
    const result = await previewJourneyAction("00000000-0000-4000-8000-000000000001", initialPreviewFormState, data);
    expect(result.formError).toContain("不支持的字段");
    expect(result.result).toBeUndefined();
    expect(result.revision).toBe(1);
  });
});
