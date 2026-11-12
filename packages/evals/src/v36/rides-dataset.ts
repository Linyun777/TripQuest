import { createHash } from "node:crypto";
import type { DraftPlace, OutingTransport } from "@tripquest/application/conversation";
import type { ConversationCase, ConversationCheck, ConversationOutcome } from "../v29/conversation-run";
import { HAICHENG, LUYU, SONGZHOU, YUNLING, worldPlaceByName } from "../v21/world";

/**
 * V3.6 对话记录交通（stages/V3.6.md §4.1）：只走对话的出游题，看卡片上的交通对不对——方式、第几天、两端在哪个城市，
 * 用户给的车站和时间没被改，没有编造的车站。题目照对比评测里实际出错的样子写（只说城市、说了坐高铁却没记、只记了去程），
 * 不用它的原句；城市是评测世界里新加的海澄（一个高铁站）、松州（两个）、鹭屿（机场和火车站）。评测“今天”是
 * 2026-10-15（周四）。写在实现之前，锁定后不改。
 */
const HANGZHOU = { adcode: "330100", name: "杭州市" } as const;
const HZ = HANGZHOU.adcode;
const HC = HAICHENG.adcode;
const SZ = SONGZHOU.adcode;
const LY = LUYU.adcode;
const YL = YUNLING.adcode;

const rides = (outcome: ConversationOutcome): readonly OutingTransport[] =>
  outcome.draft.mode === "outing" ? (outcome.draft.outing?.transports ?? []).filter((item) => item.mode !== "other") : [];

/** 这一端在不在这个城市：已绑定的看它的城市；还在等用户选的，候选都在这个城市才算（真实用户点一下就行，§1 表）。 */
const inCity = (place: DraftPlace | null, city: string) => place?.status === "bound" ? place.city === city
  : place?.status === "choose" ? place.choices.every((choice) => choice.city === city) : false;
const named = (place: DraftPlace | null, names: readonly string[]) => place?.status === "bound" && names.includes(place.name);

interface RideExpect {
  readonly day: number;
  readonly mode: "train" | "flight";
  readonly from: string;
  readonly to: string;
  /** 这一端必须是这几个之一（用户说的车站）。 */
  readonly fromNames?: readonly string[];
  readonly toNames?: readonly string[];
  /** 用户给的时刻，不能被改。 */
  readonly departAt?: string;
  readonly arriveAt?: string;
}

const ride = (name: string, expect: RideExpect): ConversationCheck => ({
  name,
  test: (outcome) => rides(outcome).some((item) => item.day === expect.day && item.mode === expect.mode &&
    inCity(item.from, expect.from) && inCity(item.to, expect.to) &&
    (!expect.fromNames || named(item.from, expect.fromNames)) && (!expect.toNames || named(item.to, expect.toNames)) &&
    (expect.departAt === undefined || item.departAt === expect.departAt) &&
    (expect.arriveAt === undefined || item.arriveAt === expect.arriveAt)),
});
const rideCount = (count: number): ConversationCheck => ({ name: `rides_${count}`, test: (outcome) => rides(outcome).length === count });
/** 卡片上已绑定的车站都是评测世界里真实的车站或机场（高德分类 1501 / 1502），没有编造。 */
const realStations: ConversationCheck = {
  name: "real_stations",
  test: (outcome) => rides(outcome).flatMap((item) => [item.from, item.to]).every((place) => {
    if (place?.status !== "bound") return true;
    return /^150[12]/.test(worldPlaceByName(place.name)?.category ?? "");
  }),
};
/** 多城出游：卡片上的每一趟交通两端都在相邻的两个城市里（没补错城市），不要求几段都齐。 */
const legsBetween = (pairs: readonly (readonly [string, string])[]): ConversationCheck => ({
  name: "legs_between_neighbours",
  test: (outcome) => rides(outcome).every((item) => pairs.some(([from, to]) =>
    (!item.from || item.from.status === "current" || inCity(item.from, from)) && (!item.to || item.to.status === "current" || inCity(item.to, to)))),
});

const c = (
  id: string,
  note: string,
  turns: readonly string[],
  checks: readonly ConversationCheck[],
  extra: Partial<ConversationCase> = {},
): ConversationCase => ({ id, note, turns, checks: [realStations, ...checks], located: HANGZHOU, outing: true, ...extra });
const fromYunling = { located: YUNLING } as const;

export const RIDES_CASES: readonly ConversationCase[] = [
  c("R01", "只说城市、坐高铁往返，那个城市只有一个高铁站", ["10月20日到22日去海澄玩三天，坐高铁，想去看灯塔", "从杭州东站出发，最后回杭州东站"], [
    rideCount(2),
    ride("out_train", { day: 1, mode: "train", from: HZ, to: HC, toNames: ["海澄站"] }),
    ride("back_train", { day: 3, mode: "train", from: HC, to: HZ, fromNames: ["海澄站"] }),
  ]),
  c("R02", "两个高铁站的城市：暂定一个，另一个可换", ["10月24日到25日周末去松州，高铁来回，想逛老街吃小吃", "杭州东站出发，回杭州东站"], [
    rideCount(2),
    ride("out_train", { day: 1, mode: "train", from: HZ, to: SZ }),
    ride("back_train", { day: 2, mode: "train", from: SZ, to: HZ }),
  ]),
  c("R03", "坐飞机往返：两端都是机场", ["11月5日到7日从云岭飞鹭屿玩三天，想去海边", "从云岭机场出发，回来也落云岭机场"], [
    rideCount(2),
    ride("out_flight", { day: 1, mode: "flight", from: YL, to: LY, fromNames: ["云岭机场"], toNames: ["鹭屿机场"] }),
    ride("back_flight", { day: 3, mode: "flight", from: LY, to: YL, fromNames: ["鹭屿机场"], toNames: ["云岭机场"] }),
  ], fromYunling),
  c("R04", "第二句才顺口说坐高铁", ["下周六周日去海澄两天，想吃海鲜", "我们坐高铁过去，从杭州东站走，最后回杭州东站"], [
    rideCount(2),
    ride("out_train", { day: 1, mode: "train", from: HZ, to: HC }),
    ride("back_train", { day: 2, mode: "train", from: HC, to: HZ }),
  ]),
  c("R05", "只说了去程的车次，回程没说", ["10月21日到23日去松州，21号早上8点的高铁从杭州东站出发，10点半到松州东站", "最后回到杭州东站"], [
    rideCount(2),
    ride("out_train_as_said", { day: 1, mode: "train", from: HZ, to: SZ, fromNames: ["杭州东站"], toNames: ["松州东站"], departAt: "08:00", arriveAt: "10:30" }),
    ride("back_train", { day: 3, mode: "train", from: SZ, to: HZ }),
  ]),
  c("R06", "用户把车站和时间都说了：一个字不动", [
    "10月20日到21日去海澄，20号上午9点杭州东站上车，11点到海澄站；21号下午5点从海澄站坐高铁回杭州东站，7点到",
    "就从杭州东站出发，回杭州东站",
  ], [
    rideCount(2),
    ride("out_as_said", { day: 1, mode: "train", from: HZ, to: HC, fromNames: ["杭州东站"], toNames: ["海澄站"], departAt: "09:00", arriveAt: "11:00" }),
    ride("back_as_said", { day: 2, mode: "train", from: HC, to: HZ, fromNames: ["海澄站"], toNames: ["杭州东站"], departAt: "17:00", arriveAt: "19:00" }),
  ]),
  c("R07", "自驾：不补高铁", ["10月24日到25日开车去海澄玩两天，看灯塔", "从杭州东站开车出发，回杭州东站"], [rideCount(0)]),
  c("R08", "一天跨城自驾回来：不补", ["10月18日开车去松州逛老街，当天晚上回来", "从杭州东站出发，晚上回杭州东站"], [rideCount(0)]),
  c("R09", "去了不回来：终点就在目的地，没有回程", ["10月20日到22日坐高铁去海澄，之后就留在海澄不回来了，想看灯塔", "从杭州东站出发，最后到海澄站就行"], [
    rideCount(1),
    ride("out_train", { day: 1, mode: "train", from: HZ, to: HC }),
  ]),
  c("R10", "回别的城市：按终点补", ["10月20日到22日坐高铁去海澄玩，最后从海澄坐高铁去松州", "从杭州东站出发，最后到松州东站"], [
    rideCount(2),
    ride("out_train", { day: 1, mode: "train", from: HZ, to: HC }),
    ride("on_to_songzhou", { day: 3, mode: "train", from: HC, to: SZ }),
  ]),
  c("R11", "多城：中间缺的段不乱补", ["10月20日到23日，先坐高铁去海澄玩两天，再去松州玩两天，最后回杭州", "从杭州东站出发，回杭州东站"], [
    legsBetween([[HZ, HC], [HC, SZ], [SZ, HZ]]),
  ]),
  c("R12", "坐飞机、出发地点不是机场：机场按城市找", ["11月6日到8日从云岭坐飞机去鹭屿，吃海鲜", "从云岭中心广场出发，最后回云岭中心广场"], [
    rideCount(2),
    ride("out_flight", { day: 1, mode: "flight", from: YL, to: LY, fromNames: ["云岭机场"], toNames: ["鹭屿机场"] }),
    ride("back_flight", { day: 3, mode: "flight", from: LY, to: YL, fromNames: ["鹭屿机场"], toNames: ["云岭机场"] }),
  ], fromYunling),
  c("R13", "留出：说的是动车，两个站的城市", ["10月27日到28日坐动车去松州玩", "杭州东站出发，回来也是杭州东站"], [
    rideCount(2),
    ride("out_train", { day: 1, mode: "train", from: HZ, to: SZ }),
    ride("back_train", { day: 2, mode: "train", from: SZ, to: HZ }),
  ], { heldOut: true }),
  c("R14", "留出：坐飞机只说了去程的航班", ["11月5日到7日去鹭屿，5号上午10点从云岭机场起飞，12点到鹭屿机场", "从云岭机场出发，最后回云岭机场"], [
    rideCount(2),
    ride("out_flight_as_said", { day: 1, mode: "flight", from: YL, to: LY, fromNames: ["云岭机场"], toNames: ["鹭屿机场"], departAt: "10:00", arriveAt: "12:00" }),
    ride("back_flight", { day: 3, mode: "flight", from: LY, to: YL, toNames: ["云岭机场"] }),
  ], { ...fromYunling, heldOut: true }),
  c("R15", "留出：只说了到哪个站，回程没提", ["10月20日到22日去海澄，坐高铁到海澄站", "从杭州东站出发，回杭州东站"], [
    rideCount(2),
    ride("out_train", { day: 1, mode: "train", from: HZ, to: HC, toNames: ["海澄站"] }),
    ride("back_train", { day: 3, mode: "train", from: HC, to: HZ }),
  ], { heldOut: true }),
  c("R16", "留出：坐高铁一天往返", ["10月18日坐高铁去海澄看灯塔，当天回来", "从杭州东站出发，晚上回杭州东站"], [
    rideCount(2),
    ride("out_train", { day: 1, mode: "train", from: HZ, to: HC }),
    ride("back_train", { day: 1, mode: "train", from: HC, to: HZ }),
  ], { heldOut: true }),
];

export const RIDES_VERSION = "v36-rides.v1";
export function ridesDigest(): string {
  const shape = RIDES_CASES.map((item) => ({ ...item, checks: item.checks.map((one) => one.name) }));
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}
