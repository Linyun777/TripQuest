import { describe, expect, it } from "vitest";

import {
  validateCreateJourneyCommand,
  type CreateJourneyCommand,
} from "../index";

const validCommand: CreateJourneyCommand = {
  title: "虚构市一日行程",
  date: "2026-10-15",
  timeZone: "Asia/Shanghai",
  activities: [
    {
      placeName: "上午地点",
      startsAt: "09:00",
      endsAt: "10:00",
      priority: "normal",
      kind: "activity",
    },
    {
      placeName: "固定晚餐",
      startsAt: "18:00",
      endsAt: "19:00",
      priority: "high",
      kind: "reservation",
    },
  ],
};

describe("create journey command validation", () => {
  it("normalizes safe text and accepts adjacent half-open intervals", () => {
    const result = validateCreateJourneyCommand({
      ...validCommand,
      title: "  虚构市一日行程  ",
      date: "2000-02-29",
      activities: [
        { ...validCommand.activities[0], placeName: "  上午地点  " },
        {
          ...validCommand.activities[1],
          startsAt: "10:00",
          endsAt: "11:00",
        },
      ],
    });

    expect(result).toMatchObject({
      success: true,
      command: {
        title: "虚构市一日行程",
        date: "2000-02-29",
        activities: [
          { placeName: "上午地点" },
          { startsAt: "10:00", endsAt: "11:00" },
        ],
      },
    });
  });

  it.each(["2026-02-29", "1900-02-29", "2026-04-31", "0000-01-01", "2026-2-03"])(
    "rejects the non-calendar date %s",
    (date) => {
      const result = validateCreateJourneyCommand({ ...validCommand, date });

      expect(result).toMatchObject({
        success: false,
        fieldErrors: { date: ["请输入有效的 YYYY-MM-DD 日期"] },
      });
    },
  );

  it("rejects malformed times and a non-positive interval with field paths", () => {
    const malformed = validateCreateJourneyCommand({
      ...validCommand,
      activities: [
        { ...validCommand.activities[0], startsAt: "9:00" },
      ],
    });
    const reversed = validateCreateJourneyCommand({
      ...validCommand,
      activities: [
        {
          ...validCommand.activities[0],
          startsAt: "10:00",
          endsAt: "10:00",
        },
      ],
    });

    expect(malformed).toMatchObject({
      success: false,
      fieldErrors: { "activities.0.startsAt": ["开始时间必须是 HH:mm"] },
    });
    expect(reversed).toMatchObject({
      success: false,
      fieldErrors: {
        "activities.0.endsAt": ["结束时间必须晚于开始时间"],
      },
    });
  });

  it("rejects overlap and out-of-order input but allows repeated place names", () => {
    const overlap = validateCreateJourneyCommand({
      ...validCommand,
      activities: [
        { ...validCommand.activities[0], placeName: "同一地点" },
        {
          ...validCommand.activities[1],
          placeName: "同一地点",
          startsAt: "09:30",
        },
      ],
    });
    const repeatedPlace = validateCreateJourneyCommand({
      ...validCommand,
      activities: validCommand.activities.map((activity) => ({
        ...activity,
        placeName: "同一地点",
      })),
    });

    expect(overlap).toMatchObject({
      success: false,
      fieldErrors: {
        "activities.1.startsAt": ["事项必须按时间排序且不能重叠"],
      },
    });
    expect(repeatedPlace).toMatchObject({ success: true });
  });

  it("enforces the 1–8 activity boundary", () => {
    const empty = validateCreateJourneyCommand({
      ...validCommand,
      activities: [],
    });
    const tooMany = validateCreateJourneyCommand({
      ...validCommand,
      activities: Array.from({ length: 9 }, (_, index) => ({
        ...validCommand.activities[0],
        startsAt: `${String(index).padStart(2, "0")}:00`,
        endsAt: `${String(index).padStart(2, "0")}:30`,
      })),
    });

    expect(empty).toMatchObject({
      success: false,
      fieldErrors: { activities: ["至少需要 1 个事项"] },
    });
    expect(tooMany).toMatchObject({
      success: false,
      fieldErrors: { activities: ["最多只能添加 8 个事项"] },
    });
  });

  it("rejects unsupported time zones and unexpected root fields", () => {
    const result = validateCreateJourneyCommand({
      ...validCommand,
      timeZone: "UTC",
      admin: true,
    });

    expect(result).toMatchObject({
      success: false,
      fieldErrors: { timeZone: ["当前只支持 Asia/Shanghai"] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.formError).toBe("输入包含不支持的字段");
    }
  });
});
