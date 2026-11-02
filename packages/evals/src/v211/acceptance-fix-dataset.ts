import { createHash } from "node:crypto";
import type { ConversationCase } from "../v29/conversation-run";
import { YUNLING } from "../v21/world";
import type { AllocationCase, OutingE2eCase } from "./outing-plan-dataset";

/**
 * V2.11 验收复测修正（stages/V2.11.md 结果“验收复测发现，待修”1–4）：每条一道题，写在修之前，先跑基线。
 * 复测那趟是“11 月 7–9 日在成都玩三天，住春熙路的全季，宽窄巷子、武侯祠、熊猫基地、杜甫草堂，晚上吃火锅”；
 * 这里在评测世界（云岭）里照着它的形状出题：最后一天 18:00 前回到车站、地点都是想去且没写停留、晚上的兴趣。
 * 锁定的 V2.11 题集（v211-outing-*）不动。
 */
const WALK_TRANSIT = { allowed: ["walking", "transit", "taxi"], prefer: "balanced" } as const;
const three = { from: "2026-10-17", to: "2026-10-19" } as const;
const station = { place: "Y-SOUTH", at: "09:00" } as const;
const backToStation = { place: "Y-SOUTH", at: "18:00" } as const;

/** 第 1 条：对话里选住处（两家同名分店，用户说“古镇那家”）。 */
export const ACCEPT_CHAT_CASES: readonly ConversationCase[] = [
  {
    id: "R01",
    note: "对话里选住处：两家山月酒店，用户说住古镇那家",
    turns: ["10月17日到19日在云岭玩三天，17号早上9点从云岭南站出发，19号晚上6点前回到云岭南站，三晚都住山月酒店", "住古镇那家"],
    located: YUNLING,
    outing: true,
    checks: [{
      name: "lodging_town",
      test: (outcome) => {
        const lodging = (outcome.draft.outing?.lodging ?? []);
        return [1, 2].every((night) => {
          const place = lodging.find((item) => item.night === night)?.place;
          return place?.status === "bound" && place.name === "山月酒店(青石古镇店)";
        });
      },
    }],
  },
];

/** 第 2、3 条：分到各天。 */
export interface AcceptAllocationCase extends AllocationCase {
  /** 模型分配不该退回规则（第 3 条：打回的原因记在结果里）。 */
  readonly modelKept?: true;
}
export const ACCEPT_ALLOCATION_CASES: readonly AcceptAllocationCase[] = [
  {
    id: "R02",
    // 前两天各有一处大半天的地方，最后一天空余最多（复测里规则就是这样把火锅放到了最后一天）。
    note: "晚上的兴趣不放进 18:00 就到车站的最后一天",
    dates: three, start: station, end: backToStation, lodging: ["Y-HOTEL-SOUTH", "Y-HOTEL-SOUTH"], transfers: [], travel: WALK_TRANSIT,
    visits: [{ place: "Y-PARK", role: "optional", stayMinutes: 240 }, { place: "Y-BEACH", role: "optional", stayMinutes: 240 }],
    interests: [{ id: "i1", text: "晚上吃海鲜", when: "evening" }],
  },
  {
    id: "R03",
    note: "复测的形状：四处想去、没写停留，晚上的兴趣，最后一天回车站；模型分配不退回规则",
    dates: three, start: station, end: backToStation, lodging: ["Y-HOTEL-TOWN", "Y-HOTEL-TOWN"], transfers: [], travel: WALK_TRANSIT,
    visits: [
      { place: "Y-TOWN", role: "optional" }, { place: "Y-GATE", role: "optional" },
      { place: "Y-BEACH", role: "optional" }, { place: "Y-SQUARE", role: "optional" },
    ],
    interests: [{ id: "i1", text: "晚上吃火锅", when: "evening" }],
    modelKept: true,
  },
];

/** 第 4 条：没写停留的地点按类型估计；整天大段空着要提示。 */
export interface AcceptOutingCase extends OutingE2eCase {
  /** 卡片上的地点（没写停留的）在方案里至少停留这么久。 */
  readonly minStay?: number;
  /** 空着 4 小时以上的天要有提示。 */
  readonly idleNoted?: true;
}
export const ACCEPT_OUTING_CASES: readonly AcceptOutingCase[] = [
  {
    ...ACCEPT_ALLOCATION_CASES[1]!,
    id: "R04",
    note: "复测的形状走到逐天生成：停留按类型估计，空着的天有提示",
    expect: "all_days",
    minStay: 90,
    idleNoted: true,
  },
];

export const ACCEPT_FIX_VERSION = "v211-accept-fix.v1";
export function acceptFixDigest(): string {
  const chat = ACCEPT_CHAT_CASES.map((item) => ({ ...item, checks: item.checks.map((one) => one.name) }));
  return createHash("sha256").update(JSON.stringify([chat, ACCEPT_ALLOCATION_CASES, ACCEPT_OUTING_CASES])).digest("hex");
}
