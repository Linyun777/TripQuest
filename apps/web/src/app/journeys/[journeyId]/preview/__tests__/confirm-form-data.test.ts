import { describe, expect, it } from "vitest";
import { parseConfirmFormData } from "../confirm-form-data";

const journeyId = "10000000-0000-4000-8000-000000000001";
const activityId = "10000000-0000-4000-8000-000000000002";

function valid(): FormData {
  const form = new FormData();
  form.set("basePlanVersion", "1");
  form.set("baseObservationVersion", "0");
  form.set("observedAt", "11:30");
  form.set("earliestResumeAt", "12:30");
  form.append("completedActivityId", activityId);
  form.set("noCurrentActivity", "yes");
  form.set("location", "at_target");
  form.set("travelMinutes", "20");
  form.set("strategy", "shift");
  form.set("semanticFingerprint", "a".repeat(64));
  form.set("idempotencyKey", "10000000-0000-4000-8000-000000000003");
  return form;
}

describe("confirmation FormData boundary", () => {
  it("accepts only the expected normalized command", () => {
    expect(parseConfirmFormData(journeyId, valid())).toMatchObject({ ok: true, command: { basePlanVersion: 1, baseObservationVersion: 0, strategy: "shift", travelMinutes: 20 } });
  });

  it("rejects extra, duplicated and malformed confirmation fields", () => {
    for (const [name, value] of [["planActivities", "[]"], ["strategy", "omit"], ["baseObservationVersion", "-1"], ["semanticFingerprint", "not-a-digest"], ["idempotencyKey", "bad"]] as const) {
      const form = valid();
      if (name === "strategy") form.append(name, value);
      else form.set(name, value);
      expect(parseConfirmFormData(journeyId, form)).toEqual({ ok: false });
    }
  });
});
