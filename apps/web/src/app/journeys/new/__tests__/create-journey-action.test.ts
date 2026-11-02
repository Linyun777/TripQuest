import { describe, expect, it, vi } from "vitest";
import { TEST_USER } from "../../../../test-support/users";

// V2.12：动作先取当前用户；测试里固定一个用户（会话本身由 Better Auth 管，不在这里测）。
vi.mock("server-only", () => ({}));
vi.mock("../../../auth/session", () => ({ pageUser: async () => TEST_USER }));

import { createJourneyAction } from "../actions";
import { initialJourneyFormState, type JourneyFormState } from "../form-state";

// Expectations are hand derived from the S3.2 acceptance contract: the Server
// Action must re-validate on the server and must refuse malformed input before
// it ever reaches PostgreSQL. The action only returns this message when the
// database path was attempted, so asserting its absence proves the request was
// rejected by validation rather than by persistence.
const DATABASE_PATH_MESSAGE = "暂时无法保存行程，请稍后重试。";

function form(entries: ReadonlyArray<readonly [string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

function activity(
  index: number,
  placeName: string,
  startsAt: string,
  endsAt: string,
  kind = "activity",
): ReadonlyArray<readonly [string, string]> {
  return [
    [`activities.${index}.placeName`, placeName],
    [`activities.${index}.startsAt`, startsAt],
    [`activities.${index}.endsAt`, endsAt],
    [`activities.${index}.priority`, kind === "reservation" ? "high" : "normal"],
    [`activities.${index}.kind`, kind],
  ];
}

function validEntries(): ReadonlyArray<readonly [string, string]> {
  return [
    ["title", "虚构市一日行程"],
    ["date", "2026-10-15"],
    ...activity(0, "上午地点", "09:00", "10:00"),
    ...activity(1, "固定晚餐", "18:00", "19:00", "reservation"),
  ];
}

async function run(
  entries: ReadonlyArray<readonly [string, string]>,
  previous: JourneyFormState = initialJourneyFormState,
): Promise<JourneyFormState> {
  return createJourneyAction(previous, form(entries));
}

describe("S3.2 create journey server action", () => {
  it("refuses a browser-bypassed overlap before touching PostgreSQL", async () => {
    const state = await run([
      ["title", "重叠行程"],
      ["date", "2026-10-15"],
      ...activity(0, "上午地点", "09:00", "10:00"),
      ...activity(1, "重叠事项", "09:30", "11:00"),
    ]);

    expect(state.formError, "not a persistence failure").not.toBe(DATABASE_PATH_MESSAGE);
    expect(state.fieldErrors["activities.1.startsAt"], "overlap reported on the later item").toContain(
      "事项必须按时间排序且不能重叠",
    );
  });

  it("refuses out-of-order and reversed windows before touching PostgreSQL", async () => {
    const outOfOrder = await run([
      ["title", "逆序行程"],
      ["date", "2026-10-15"],
      ...activity(0, "下午地点", "15:00", "16:00"),
      ...activity(1, "上午地点", "09:00", "10:00"),
    ]);
    expect(outOfOrder.formError, "not a persistence failure").not.toBe(DATABASE_PATH_MESSAGE);
    expect(Object.keys(outOfOrder.fieldErrors), "later item is flagged").toContain("activities.1.startsAt");

    const reversed = await run([
      ["title", "倒置区间"],
      ["date", "2026-10-15"],
      ...activity(0, "上午地点", "10:00", "09:00"),
    ]);
    expect(reversed.formError, "not a persistence failure").not.toBe(DATABASE_PATH_MESSAGE);
    expect(reversed.fieldErrors["activities.0.endsAt"], "end before start").toContain(
      "结束时间必须晚于开始时间",
    );
  });

  it("refuses blank text, impossible dates and too many activities server side", async () => {
    const blankTitle = await run([
      ["title", "   "],
      ["date", "2026-10-15"],
      ...activity(0, "上午地点", "09:00", "10:00"),
    ]);
    expect(blankTitle.formError, "not a persistence failure").not.toBe(DATABASE_PATH_MESSAGE);
    expect(Object.keys(blankTitle.fieldErrors), "title flagged").toContain("title");

    const impossibleDate = await run([
      ["title", "虚构市一日行程"],
      ["date", "2026-02-29"],
      ...activity(0, "上午地点", "09:00", "10:00"),
    ]);
    expect(impossibleDate.formError, "not a persistence failure").not.toBe(DATABASE_PATH_MESSAGE);
    expect(Object.keys(impossibleDate.fieldErrors), "date flagged").toContain("date");

    const nineActivities = Array.from({ length: 9 }, (_, index) =>
      activity(index, `地点 ${index}`, `0${index}:00`, `0${index}:30`),
    ).flat();
    const tooMany = await run([
      ["title", "九项行程"],
      ["date", "2026-10-15"],
      ...nineActivities,
    ]);
    expect(tooMany.formError, "not a persistence failure").not.toBe(DATABASE_PATH_MESSAGE);
    expect(Object.keys(tooMany.fieldErrors), "activity list flagged").toContain("activities");
  });

  it("refuses unknown, duplicated and oversized fields at the form level", async () => {
    const unknown = await run([...validEntries(), ["isAdmin", "true"]]);
    expect(unknown.formError, "unknown field message").toContain("重复或不支持的字段");
    expect(unknown.formError).not.toBe(DATABASE_PATH_MESSAGE);

    const duplicated = form(validEntries());
    duplicated.append("title", "另一份行程");
    const duplicateState = await createJourneyAction(initialJourneyFormState, duplicated);
    expect(duplicateState.formError, "duplicate field message").toContain("重复或不支持的字段");

    const oversized = await run([
      ["title", "超长字段"],
      ["date", "2026-10-15"],
      ...activity(0, "上午地点", "09:00", "10:00"),
      ["activities.1.placeName", "x".repeat(501)],
    ]);
    expect(oversized.formError, "oversized value message").toContain("重复或不支持的字段");
  });

  it("keeps submitted values and bumps the revision on every rejected attempt", async () => {
    const first = await run([
      ["title", "  保留我  "],
      ["date", "2026-10-15"],
      ...activity(0, "", "09:00", "10:00"),
    ]);
    expect(first.revision, "revision bumped").toBe(1);
    expect(first.values.title, "typed title echoed back").toBe("  保留我  ");
    expect(first.values.activities[0]?.placeName, "empty place echoed back").toBe("");

    const second = await createJourneyAction(first, form([
      ["title", "  保留我  "],
      ["date", "2026-10-15"],
      ...activity(0, "上午地点", "09:00", "10:00"),
      ...activity(1, "重叠事项", "09:30", "10:30"),
    ]));
    expect(second.revision, "revision keeps increasing").toBe(2);
    expect(second.formError, "still not a persistence failure").not.toBe(DATABASE_PATH_MESSAGE);
  });
});
