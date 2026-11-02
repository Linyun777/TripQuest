import { V2_IDS, type V2PlannerId } from "./dataset";
export interface AgentOptions {
  mode: "scripted" | "live";
  caseIds?: string[];
  plannerIds?: V2PlannerId[];
  profileId?: string;
  smoke?: "developer" | "test-1" | "test-2";
}
export function parseAgentOptions(raw: readonly string[]): AgentOptions {
  const args = raw[0] === "--" ? raw.slice(1) : raw;
  const options: AgentOptions = { mode: "scripted" };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (seen.has(flag) || !value) throw new Error("Invalid CLI arguments");
    seen.add(flag);
    switch (flag) {
      case "--mode":
        if (value !== "scripted" && value !== "live") throw new Error("Invalid mode");
        options.mode = value;
        break;
      case "--case":
        options.caseIds = value.split(",");
        if (new Set(options.caseIds).size !== options.caseIds.length ||
          options.caseIds.some((id) => !/^E(0[1-9]|1[0-4])$/.test(id))) {
          throw new Error("Invalid cases");
        }
        break;
      case "--planner":
        if (!V2_IDS.includes(value as V2PlannerId)) throw new Error("Invalid planner");
        options.plannerIds = [value as V2PlannerId];
        break;
      case "--profile":
        if (!/^[a-z0-9-]{1,64}$/.test(value)) throw new Error("Invalid profile ID");
        options.profileId = value;
        break;
      case "--smoke":
        if (!["developer", "test-1", "test-2"].includes(value)) throw new Error("Invalid smoke round");
        options.smoke = value as AgentOptions["smoke"];
        break;
      default:
        throw new Error("Unknown CLI argument");
    }
  }
  if (options.mode === "live") {
    if (!options.smoke || options.caseIds || options.plannerIds) {
      throw new Error("Live requires one fixed smoke round; arbitrary live selection is disabled");
    }
  } else if (options.profileId || options.smoke) {
    throw new Error("Live options cannot be used in scripted mode");
  }
  return options;
}
