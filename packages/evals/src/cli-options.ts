import { PLANNER_IDS, type PlannerId } from "./contracts";
export function parseOptions(raw: readonly string[]): { caseIds?: string[]; plannerIds: PlannerId[] } {
  const args = raw[0] === "--" ? raw.slice(1) : [...raw];
  const seen = new Set<string>();
  let caseIds: string[] | undefined;
  let plannerIds = [...PLANNER_IDS];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]; const value = args[i + 1];
    if (!["--case", "--planner"].includes(flag) || seen.has(flag) || !value) throw new Error("Usage: eval:baseline [--case E01,E05] [--planner rules_only|fixed_workflow]");
    seen.add(flag);
    if (flag === "--case") {
      caseIds = value.split(",");
      if (new Set(caseIds).size !== caseIds.length || caseIds.some((id) => !/^E(0[1-9]|1[0-2])$/.test(id))) throw new Error("Unknown or duplicate case ID");
    } else {
      if (!PLANNER_IDS.includes(value as PlannerId)) throw new Error("Unknown planner ID");
      plannerIds = [value as PlannerId];
    }
  }
  return { caseIds, plannerIds };
}
