import { z } from "zod";

import type {
  CreateJourneyCommand,
  JourneyFieldErrors,
} from "./contracts";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const activitySchema = z.strictObject({
  placeName: z
    .string({ error: "请输入地点名称" })
    .trim()
    .min(1, "请输入地点名称")
    .max(80, "地点名称最多 80 个字符"),
  startsAt: z
    .string({ error: "请输入开始时间" })
    .regex(TIME_PATTERN, "开始时间必须是 HH:mm"),
  endsAt: z
    .string({ error: "请输入结束时间" })
    .regex(TIME_PATTERN, "结束时间必须是 HH:mm"),
  priority: z.enum(["high", "normal", "low"], {
    error: "请选择有效优先级",
  }),
  kind: z.enum(["activity", "reservation"], {
    error: "请选择有效事项类型",
  }),
});

export const createJourneyCommandSchema = z
  .strictObject({
    title: z
      .string({ error: "请输入行程名称" })
      .trim()
      .min(1, "请输入行程名称")
      .max(80, "行程名称最多 80 个字符"),
    date: z.string({ error: "请输入行程日期" }),
    timeZone: z.literal("Asia/Shanghai", {
      error: "当前只支持 Asia/Shanghai",
    }),
    activities: z
      .array(activitySchema, { error: "请填写行程事项" })
      .min(1, "至少需要 1 个事项")
      .max(8, "最多只能添加 8 个事项"),
  })
  .superRefine((command, context) => {
    if (!isRealCalendarDate(command.date)) {
      context.addIssue({
        code: "custom",
        path: ["date"],
        message: "请输入有效的 YYYY-MM-DD 日期",
      });
    }

    for (let index = 0; index < command.activities.length; index += 1) {
      const activity = command.activities[index];
      const startsAt = timeToMinutes(activity.startsAt);
      const endsAt = timeToMinutes(activity.endsAt);

      if (startsAt !== null && endsAt !== null && startsAt >= endsAt) {
        context.addIssue({
          code: "custom",
          path: ["activities", index, "endsAt"],
          message: "结束时间必须晚于开始时间",
        });
      }

      if (index === 0 || startsAt === null) continue;
      const previousEndsAt = timeToMinutes(command.activities[index - 1].endsAt);
      if (previousEndsAt !== null && startsAt < previousEndsAt) {
        context.addIssue({
          code: "custom",
          path: ["activities", index, "startsAt"],
          message: "事项必须按时间排序且不能重叠",
        });
      }
    }
  });

export type CreateJourneyValidationResult =
  | { readonly success: true; readonly command: CreateJourneyCommand }
  | {
      readonly success: false;
      readonly fieldErrors: JourneyFieldErrors;
      readonly formError?: string;
    };

export function validateCreateJourneyCommand(
  input: unknown,
): CreateJourneyValidationResult {
  const result = createJourneyCommandSchema.safeParse(input);
  if (result.success) {
    return { success: true, command: result.data };
  }

  const fieldErrors: Record<string, string[]> = {};
  const formErrors: string[] = [];

  for (const issue of result.error.issues) {
    const message =
      issue.code === "unrecognized_keys"
        ? "输入包含不支持的字段"
        : issue.message;
    if (issue.path.length === 0) {
      formErrors.push(message);
      continue;
    }

    const path = issue.path.map(String).join(".");
    (fieldErrors[path] ??= []).push(message);
  }

  return {
    success: false,
    fieldErrors,
    ...(formErrors.length === 0
      ? {}
      : { formError: formErrors.join("；") }),
  };
}

function isRealCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function timeToMinutes(value: string): number | null {
  if (!TIME_PATTERN.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}
