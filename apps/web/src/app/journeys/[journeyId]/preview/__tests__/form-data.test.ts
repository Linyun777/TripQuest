import { describe, expect, it } from "vitest";
import { parsePreviewFormData } from "../form-data";

const journeyId = "00000000-0000-4000-8000-000000000001";
const morningId = "00000000-0000-4000-8000-000000000002";
function form() {
  const data = new FormData();
  data.set("basePlanVersion", "1"); data.set("observedAt", "14:30"); data.set("earliestResumeAt", "15:30");
  data.set("completedActivityId", morningId); data.set("noCurrentActivity", "yes"); data.set("location", "at_target"); data.set("travelMinutes", "40");
  return data;
}

describe("S3.3 raw FormData boundary", () => {
  it("accepts only bounded user declarations", () => {
    const parsed = parsePreviewFormData(journeyId, form());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.command).toMatchObject({ journeyId, basePlanVersion: 1, travelMinutes: 40, completedActivityIds: [morningId] });
  });
  it("rejects duplicate, forged, unknown, and invalid minute fields", () => {
    for (const [key, value] of [["basePlanVersion", "2"], ["placeId", "forged"], ["reservationId", "forged"], ["travelMinutes", "0"], ["travelMinutes", "241"]] as const) {
      const data = form(); data.append(key, value);
      expect(parsePreviewFormData(journeyId, data).ok, key).toBe(false);
    }
    const duplicateCompleted = form(); duplicateCompleted.append("completedActivityId", morningId);
    expect(parsePreviewFormData(journeyId, duplicateCompleted).ok).toBe(false);
  });
  it("rejects reversed time, invalid route ID, and file values", () => {
    const reversed = form(); reversed.set("earliestResumeAt", "14:29");
    expect(parsePreviewFormData(journeyId, reversed).ok).toBe(false);
    expect(parsePreviewFormData("forged", form()).ok).toBe(false);
    const file = form(); file.set("location", new File(["x"], "x.txt"));
    expect(parsePreviewFormData(journeyId, file).ok).toBe(false);
  });
});
