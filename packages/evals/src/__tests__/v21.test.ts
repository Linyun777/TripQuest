import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatDecisionModel } from "@tripquest/agent/chat";
import { createDayScriptedModel } from "@tripquest/agent/day-planning";
import { INTAKE_CASES } from "../v21/intake-dataset";
import { PLAN_CASES } from "../v21/plan-dataset";
import { v21ModelBudget } from "../v21/budget";
import { runIntakeCase, runPlanCase } from "../v21/run";
import { V21_NOW } from "../v21/world";

const intake = (id: string) => INTAKE_CASES.find((item) => item.id === id)!;
const plan = (id: string) => PLAN_CASES.find((item) => item.id === id)!;

function scriptedChat(decisions: unknown[]): () => ChatDecisionModel {
  return () => ({
    mode: "scripted",
    provider: "test",
    model: "scripted",
    async decide() {
      return { decision: decisions.shift() ?? { action: "reply", text: "好的" }, usage: null };
    },
  });
}

describe("V2.1 evaluation harness", () => {
  it("scores an intake conversation from the final draft and replies", async () => {
    const good = await runIntakeCase(intake("I01"), scriptedChat([
      {
        actions: [
          { action: "search_place", mention: "东门广场", purpose: "start" },
          { action: "search_place", mention: "湖滨终点商场", purpose: "end" },
        ],
      },
      {
        actions: [
          {
            action: "update_requirements",
            patch: {
              date: "2026-10-16", startsAt: "09:00", endsAt: "18:00",
              start: { candidate: "c1" }, end: { candidate: "c3" }, addInterests: ["越剧相关"],
            },
          },
          { action: "reply", text: "好的，整理好了。" },
        ],
      },
    ]));
    expect(good).toMatchObject({ passed: true, modelRequests: 2, searches: 2 });

    // Picking the subway entrance instead of the square fails the check, not the harness.
    const wrong = await runIntakeCase(intake("I13"), scriptedChat([
      { action: "search_place", mention: "东门广场", purpose: "start" },
      { actions: [{ action: "update_requirements", patch: { start: { candidate: "c2" } } }, { action: "reply", text: "好" }] },
    ]));
    expect(wrong.checks.find((check) => check.name === "start_bound_main_place")?.passed).toBe(false);
  });

  it("checks weather replies for numbers, which belong on the card only", async () => {
    const row = await runIntakeCase(intake("I06"), scriptedChat([
      { action: "get_weather", date: "2026-10-17" },
      { action: "reply", text: "后天有小雨，最高 21℃。" },
    ]));
    expect(row.checks.find((check) => check.name === "reply_without_temperatures")?.passed).toBe(false);
    expect(row.checks.find((check) => check.name === "mentions_rain")?.passed).toBe(true);
  });

  it("runs every planning case with the rules policy without violations, and finds no plan for skiing", async () => {
    const rows = await Promise.all(PLAN_CASES.map((item) => runPlanCase(item, "scripted")));
    expect(rows.every((row) => row.violations.length === 0)).toBe(true);
    expect(rows.find((row) => row.caseId === "P05")).toMatchObject({ outcome: "no_plan", outcomeMatched: true });
    // Coverage comes from the hand-written ground truth, not from the planner's own claims.
    expect(rows.find((row) => row.caseId === "P10")).toMatchObject({ covered: 0, interests: 1 });
  });

  it("turns a policy that keeps breaking rules into a plan that still keeps the appointment", async () => {
    // Every try names an unknown stop; the guard refuses each, then the code fallback
    // schedules the fixed appointment alone. The independent recheck finds nothing wrong.
    const row = await runPlanCase(plan("P01"), "live", () => createDayScriptedModel(() => ({
      action: "try_itinerary", orderedActivityIds: ["a9"],
    })));
    expect(row).toMatchObject({ outcome: "draft", fallback: true, stops: ["城东博物馆"], violations: [] });
  });

  it("records each live request in the shared local ledger", async () => {
    const directory = mkdtempSync(join(tmpdir(), "v21-budget-"));
    try {
      const budget = v21ModelBudget(directory, () => V21_NOW);
      await budget.beforeRequest();
      await budget.beforeRequest();
      const lines = readFileSync(join(directory, "local-usage.jsonl"), "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toMatchObject({ pool: "model", purpose: "eval-v21" });
      expect(budget.used()).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

});
