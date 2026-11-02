import { createInvestigation, createScriptedModel } from "@tripquest/agent";
import { generateBaselineCandidate } from "@tripquest/domain";
import { clarificationCase, places } from "./cases";

/** Negative mechanisms: expected rejection is separate from business success. */
export async function runSessionBoundaries() {
  const rows = [];
  for (const id of ["C04-wrong", "C04-stale", "C04-duplicate", "C04-concurrent", "C04-cancel", "C05-pending", "C05-stale"]) {
    const base = clarificationCase("C02").input;
    const input = id === "C05-pending" ? {
      ...base,
      reservations: base.reservations.map((entry) => ({
        ...entry, confirmation: { ...entry.confirmation, status: "pending" as const },
      })),
    } : id === "C05-stale" ? {
      ...base, request: { ...base.request, baseStateVersion: 99 },
    } : base;
    let models = 0;
    let routes = 0;
    const session = createInvestigation(input, {
      places, decisionPolicy: "feedback_once", plan: generateBaselineCandidate,
      model: {
        ...createScriptedModel(),
        async decide() {
          models++;
          throw new Error("Unexpected model");
        },
      },
      async lookupRoute() {
        routes++;
        throw new Error("Unexpected route");
      },
    });
    let snapshot = await session.start();
    const answer = {
      questionId: snapshot.question?.questionId,
      snapshotFingerprint: snapshot.question?.snapshotFingerprint,
      choice: "cannot_answer",
    };
    let rejected = 0;
    const attempt = async (value: unknown, current = input) => {
      try { await session.answer(value, current); }
      catch { rejected++; }
    };
    if (id === "C04-wrong") await attempt({ ...answer, questionId: "wrong" });
    if (id === "C04-stale") {
      await attempt(answer, { ...input, transferBufferMinutes: 11 });
      await attempt(answer);
    }
    if (id === "C04-duplicate") {
      await attempt(answer);
      await attempt(answer);
    }
    if (id === "C04-concurrent") await Promise.all([attempt(answer), attempt(answer)]);
    if (id === "C04-cancel") {
      session.cancel();
      await attempt(answer);
    }
    snapshot = session.snapshot();
    const expectedRejections = id.startsWith("C05") ? 0 : id === "C04-stale" ? 2 : 1;
    const passed = models === 0 && routes === 0 && rejected === expectedRejections &&
      (id.startsWith("C05") ? snapshot.question === null : true) &&
      snapshot.followup === null;
    rows.push({
      caseId: id, evidenceKind: "scripted-boundary", expectedRejections,
      rejected, models, routes, snapshot, mechanismPassed: passed,
    });
  }
  return rows;
}
