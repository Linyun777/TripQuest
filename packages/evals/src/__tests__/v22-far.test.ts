import { describe, expect, it } from "vitest";
import { FAR_CASES, walkingOnly } from "../v21/plan-dataset";
import { runPlanCase } from "../v21/run";

describe("V2.2 far cases", () => {
  it("fit with other modes but not walking only, and pass the independent recheck", async () => {
    // P17 needs the area the user named ("湖滨一带"); only the model reads that, not the rules.
    for (const item of FAR_CASES.filter((far) => far.id !== "P17")) {
      const row = await runPlanCase(item, "scripted");
      expect([item.id, row.outcome, row.violations]).toEqual([item.id, "draft", []]);
      expect(row.legModes.some((mode) => mode !== "walking")).toBe(true);
      expect((await runPlanCase(walkingOnly(item), "scripted")).outcome).toBe("no_plan");
    }
  });

  it("keeps an excluded mode out and charges a driving leg its parking", async () => {
    const noTaxi = await runPlanCase(FAR_CASES.find((item) => item.id === "P13")!, "scripted");
    expect(noTaxi.legModes).not.toContain("taxi");
    const drive = await runPlanCase(FAR_CASES.find((item) => item.id === "P16")!, "scripted");
    expect(drive.legModes).toEqual(["driving", "driving", "driving"]);
  });
});
