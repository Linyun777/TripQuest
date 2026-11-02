import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dataset } from "../cases/dataset";
import { datasetV2, V2_IDS } from "../v2/dataset";
import { canonical, datasetHash } from "../dataset-validation";
import { scoreV2 } from "../v2/scoring";
import { runMechanism, runNatural } from "../v3/runner";
import { sourceCase } from "../v3/cases";

/**
 * S4.3 independent tests for the v3 evaluation layer. The accepted S4.2
 * dataset digests below were recorded in the S4.2 acceptance evidence, so a
 * silent edit of either dataset fails here.
 */

const S42_V1_DATASET_SHA256 = "e5ca0c0c88916fb4d2ca9c57d61ca283d11451191f28f638774efddf96eafed3";
const S42_V2_DATASET_SHA256 = "4c82bc18d4b28c3d1760d16e6e66846458b59a939b745884f8c8f0d1e1be1939";
const git = { sha: "independent-test", dirty: true };

describe("v3 evaluation layer", () => {
  it("keeps the accepted v1 and v2 datasets byte-identical", () => {
    expect(dataset.cases, "v1 stays at twelve cases").toHaveLength(12);
    expect(datasetV2.cases, "v2 stays at fourteen cases").toHaveLength(14);
    expect(datasetHash(dataset), "v1 dataset digest unchanged").toBe(S42_V1_DATASET_SHA256);
    expect(
      createHash("sha256").update(canonical(datasetV2)).digest("hex"),
      "v2 dataset digest unchanged",
    ).toBe(S42_V2_DATASET_SHA256);
  });

  it("excuses exactly one recovered repair instead of loosening the score", async () => {
    const recovered = await runMechanism("F01");
    expect(recovered.output?.repairAttempts, "one repair was consumed").toBe(1);
    expect(recovered.output?.rejectedActions).toBe(1);
    const v2 = scoreV2(sourceCase("E13"), "model_agent", recovered.output!, recovered.calls, recovered.trace);
    expect(v2.quality, "the business result stays correct").toBe(true);
    expect(v2.safety, "facts stay protected").toBe(true);
    expect(v2.execution, "the accepted v2 rule still rejects every refusal").toBe(false);
    expect(v2.executionFailures).toContain("rejected_actions");
    expect(recovered.score?.repair, "v3 records the recovery").toBe("recovered");
    expect(recovered.score?.passed, "v3 accepts this one trajectory").toBe(true);

    const failed = await runMechanism("F03");
    expect(failed.output?.executionStatus).toBe("invalid_decision");
    expect(failed.output?.routeRequests, "a rejected direction never reaches the tool").toBe(0);
    expect(failed.score?.repair, "an unrepaired rejection is not excused").toBe("failed");
    expect(failed.score?.execution).toBe(false);
    expect(failed.score?.passed).toBe(false);
  });

  it("gives all five strategies one answered snapshot and repairs nothing spontaneously", async () => {
    const rows = await runNatural({ git });
    const c02 = rows.filter((row) => row.caseId === "C02");
    expect(c02, "five strategies on the clarification case").toHaveLength(5);
    expect(new Set(c02.map((row) => row.plannerId))).toEqual(
      new Set([...V2_IDS, "model_agent_feedback"]),
    );
    expect(c02.every((row) => row.exception === null)).toBe(true);
    expect(c02.every((row) => row.initialStatus === "needs_information")).toBe(true);
    expect(new Set(c02.map((row) => row.answeredSnapshot)).size, "one shared post-answer snapshot").toBe(1);
    expect(c02[0].answeredSnapshot).not.toBeNull();
    expect(
      new Set(c02.map((row) => canonical(row.planningCalls[0].input))).size,
      "every strategy planned the identical input",
    ).toBe(1);
    expect(c02.every((row) => row.repairUsage === "unused"), "natural runs never repair").toBe(true);
    const withFeedback = c02.find((row) => row.plannerId === "model_agent_feedback")!;
    const plain = c02.find((row) => row.plannerId === "model_agent")!;
    expect(withFeedback.output?.repairAttempts, "the new policy really is active").toBe(0);
    expect(plain.output?.repairAttempts, "the old strategy keeps the old contract").toBeUndefined();
    expect(canonical(withFeedback.planningCalls[0].input)).toBe(canonical(plain.planningCalls[0].input));
  });
});
