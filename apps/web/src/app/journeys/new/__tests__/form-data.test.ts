import { validateCreateJourneyCommand } from "@tripquest/application";
import { describe, expect, it } from "vitest";

import { parseJourneyFormData } from "../form-data";

function validFormData(): FormData {
  const data = new FormData();
  data.set("title", "虚构市一日行程");
  data.set("date", "2026-10-10");
  data.set("activities.0.placeName", "城市博物馆");
  data.set("activities.0.startsAt", "09:00");
  data.set("activities.0.endsAt", "10:00");
  data.set("activities.0.priority", "normal");
  data.set("activities.0.kind", "activity");
  return data;
}

describe("journey FormData boundary", () => {
  it("accepts an ordered form and passes its values to the application validator", () => {
    const data = validFormData();
    data.set("activities.1.placeName", "固定晚餐");
    data.set("activities.1.startsAt", "18:00");
    data.set("activities.1.endsAt", "19:00");
    data.set("activities.1.priority", "high");
    data.set("activities.1.kind", "reservation");

    const parsed = parseJourneyFormData(data);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.values.activities.map((activity) => activity.placeName)).toEqual([
      "城市博物馆",
      "固定晚餐",
    ]);
    expect(
      validateCreateJourneyCommand({
        ...parsed.values,
        timeZone: "Asia/Shanghai",
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate, unexpected, and file fields before persistence", () => {
    const duplicate = validFormData();
    duplicate.append("title", "另一份行程");
    expect(parseJourneyFormData(duplicate).ok).toBe(false);

    const unexpected = validFormData();
    unexpected.set("isAdmin", "true");
    expect(parseJourneyFormData(unexpected).ok).toBe(false);

    const file = validFormData();
    file.set("title", new File(["x"], "x.txt"));
    expect(parseJourneyFormData(file).ok).toBe(false);
  });

  it("rejects sparse indices and oversized forms", () => {
    const sparse = validFormData();
    sparse.set("activities.2.placeName", "跳过编号一");
    expect(parseJourneyFormData(sparse).ok).toBe(false);

    const alias = validFormData();
    alias.set("activities.00.placeName", "别名字段");
    expect(parseJourneyFormData(alias).ok).toBe(false);

    const oversized = validFormData();
    oversized.set("activities.99.placeName", "越界事项");
    expect(parseJourneyFormData(oversized).ok).toBe(false);
  });

  it("keeps browser-bypass time conflicts for server validation", () => {
    const overlapping = validFormData();
    overlapping.set("activities.1.placeName", "重叠事项");
    overlapping.set("activities.1.startsAt", "09:30");
    overlapping.set("activities.1.endsAt", "11:00");
    overlapping.set("activities.1.priority", "normal");
    overlapping.set("activities.1.kind", "activity");

    const parsed = parseJourneyFormData(overlapping);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const validation = validateCreateJourneyCommand({
      ...parsed.values,
      timeZone: "Asia/Shanghai",
    });
    expect(validation.success).toBe(false);
    if (validation.success) return;
    expect(validation.fieldErrors["activities.1.startsAt"]).toContain(
      "事项必须按时间排序且不能重叠",
    );
  });
});
