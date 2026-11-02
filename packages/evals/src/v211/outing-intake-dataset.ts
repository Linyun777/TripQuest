import { createHash } from "node:crypto";
import type { ConversationCase, ConversationCheck, ConversationOutcome } from "../v29/conversation-run";
import { YUNLING } from "../v21/world";

/**
 * V2.11 出游需求理解（stages/V2.11.md §3.3、§4.3）：在出游模式里说一段话，看卡片上的日期、每晚住处、
 * 固定交通、指定某天的地点和兴趣对不对。评测“今天”是 2026-10-15（周四）；题里用具体日期。
 * 卡片形状按设计写（`mode: "outing"`，出游字段在 `outing` 里），写在实现之前，锁定后不改。
 * 现在的产品没有出游模式，按日常卡片跑，这就是基线。
 */
type Place = { readonly status?: string; readonly name?: string; readonly choices?: readonly { readonly name: string }[] } | null | undefined;
interface OutingView {
  readonly dates?: { readonly from: string; readonly to: string } | null;
  readonly startAt?: string | null;
  readonly endAt?: string | null;
  readonly lodging?: readonly { readonly night: number; readonly place?: Place; readonly onBoard?: boolean }[];
  readonly transports?: readonly {
    readonly day: number;
    readonly mode: string;
    readonly from?: Place;
    readonly to?: Place;
    readonly departAt?: string | null;
    readonly arriveAt?: string | null;
    readonly arriveDay?: string;
    readonly overnightConfirmed?: boolean;
  }[];
}
/** 出游卡片（按设计的形状读，不依赖现在的类型）。 */
interface Card {
  readonly mode?: string;
  readonly outing?: OutingView;
  readonly start?: Place;
  readonly end?: Place;
  readonly notes?: string | null;
  readonly travel?: { readonly allowed: readonly string[] };
  readonly visits: readonly {
    readonly place: Place;
    readonly role: string;
    readonly day?: number;
    readonly startsAt?: string | null;
    readonly endsAt?: string | null;
  }[];
  readonly interests: readonly {
    readonly text: string;
    readonly when?: string;
    readonly day?: number;
    readonly perDay?: boolean;
    readonly city?: { readonly adcode: string };
  }[];
}
const card = (outcome: ConversationOutcome) => outcome.draft as unknown as Card;
const outing = (outcome: ConversationOutcome): OutingView | null => (card(outcome).mode === "outing" ? card(outcome).outing ?? null : null);
/** 已绑定的名称；还在等用户选时算候选里的名称。 */
const names = (place: Place): string[] => place?.status === "bound" && place.name ? [place.name]
  : place?.status === "choose" ? (place.choices ?? []).map((choice) => choice.name) : [];
const last = (outcome: ConversationOutcome) => outcome.replies.at(-1) ?? "";

const check = (name: string, test: (outcome: ConversationOutcome, view: OutingView) => boolean): ConversationCheck => ({
  name,
  test: (outcome) => {
    const view = outing(outcome);
    return !!view && test(outcome, view);
  },
});
const isOuting = check("outing_card", () => true);
const dates = (from: string, to: string) => check(`dates_${from.slice(5)}_${to.slice(5)}`, (_, view) => view.dates?.from === from && view.dates?.to === to);
const lodgingIs = (...expected: readonly string[]) => check("lodging", (_, view) =>
  expected.every((name, index) => names(view.lodging?.find((item) => item.night === index + 1)?.place).includes(name)));
const transport = (name: string, test: (item: NonNullable<OutingView["transports"]>[number]) => boolean) =>
  check(name, (_, view) => (view.transports ?? []).some(test));
const visitOnDay = (place: string, day: number) => check(`visit_${place}_day${day}`, (outcome) =>
  card(outcome).visits.some((visit) => visit.day === day && names(visit.place).includes(place)));
const visitBound = (place: string) => check(`visit_${place}`, (outcome) => card(outcome).visits.some((visit) => names(visit.place).includes(place)));
const startIs = (place: string) => check(`start_${place}`, (outcome) => names(card(outcome).start).includes(place));
const endIs = (place: string) => check(`end_${place}`, (outcome) => names(card(outcome).end).includes(place));
const allows = (mode: string) => check(`travel_${mode}`, (outcome) => !!card(outcome).travel?.allowed.includes(mode));

const c = (id: string, note: string, turns: readonly string[], checks: readonly ConversationCheck[], extra: Partial<ConversationCase> = {}): ConversationCase =>
  ({ id, note, turns, checks: [isOuting, ...checks], located: YUNLING, outing: true, ...extra });
const fromHangzhou = { located: { adcode: "330100", name: "杭州市" } } as const;

export const OUTING_INTAKE_CASES: readonly ConversationCase[] = [
  c("O01", "一天跨城市：从云岭开车去岚溪，晚上回来", ["10月17日从云岭站开车去岚溪花海看花，再去岚溪水乡吃饭，晚上回云岭站"], [
    dates("2026-10-17", "2026-10-17"), startIs("云岭站"), endIs("云岭站"), visitBound("岚溪花海"), visitBound("岚溪水乡"), allows("driving"),
  ]),
  c("O02", "多天，整趟一个住处", ["10月17日到19日在云岭玩三天，都住云岭山居酒店"], [
    dates("2026-10-17", "2026-10-19"), lodgingIs("云岭山居酒店", "云岭山居酒店"),
  ]),
  c("O03", "某晚换住处", ["17号到19号在云岭，第一晚住云岭山居酒店，第二晚住青石客栈"], [
    dates("2026-10-17", "2026-10-19"), lodgingIs("云岭山居酒店", "青石客栈"),
  ]),
  c("O04", "出发和结束的地点与时间", ["10月17日到18日在云岭玩，17号早上8点从云岭站出发，18号晚上7点前回到云岭站"], [
    dates("2026-10-17", "2026-10-18"), startIs("云岭站"), endIs("云岭站"),
    check("start_at_08", (_, view) => view.startAt === "08:00"), check("end_by_19", (_, view) => view.endAt === "19:00"),
  ]),
  c("O05", "带时间的高铁", ["10月17日坐8点的高铁从杭州东站去云岭南站，11点到，玩到18号"], [
    dates("2026-10-17", "2026-10-18"),
    transport("train_with_times", (item) => item.day === 1 && item.mode === "train" && names(item.from).includes("杭州东站") &&
      names(item.to).includes("云岭南站") && item.departAt === "08:00" && item.arriveAt === "11:00"),
  ], fromHangzhou),
  c("O06", "只说了城市没说车站：绑定那个城市的车站", ["17号坐高铁从杭州去云岭，18号回来"], [
    transport("train_stations", (item) => item.mode === "train" && names(item.from).includes("杭州东站") && names(item.to).includes("云岭南站")),
  ], fromHangzhou),
  c("O07", "车次还没定：时间空着", ["17号坐高铁去云岭，车次还没定，18号回杭州"], [
    transport("train_time_empty", (item) => item.day === 1 && item.mode === "train" && !item.departAt && !item.arriveAt),
  ], fromHangzhou),
  c("O08", "夜车：第二天到，要确认，那晚不填住处", ["17号晚上坐夜车从杭州去云岭，第二天早上到，玩到19号"], [
    dates("2026-10-17", "2026-10-19"),
    transport("overnight_train", (item) => item.day === 1 && item.mode === "train" && item.arriveDay === "next" && !item.overnightConfirmed),
    check("no_lodging_night1", (_, view) => {
      const night = view.lodging?.find((item) => item.night === 1);
      return !night || !!night.onBoard || !night.place;
    }),
  ], fromHangzhou),
  c("O09", "红眼航班回程", ["10月17日到19日在云岭，19号晚上坐红眼航班从云岭机场飞回杭州"], [
    transport("red_eye", (item) => item.day === 3 && item.mode === "flight" && names(item.from).includes("云岭机场") && item.arriveDay === "next"),
  ]),
  c("O10", "指定某天的地点", ["17到19号在云岭，第二天去爬云岭山"], [dates("2026-10-17", "2026-10-19"), visitOnDay("云岭山(山门)", 2)]),
  c("O11", "固定事项：某天几点到几点", ["17到19号在云岭，18号下午2点到4点在云岭博物馆听讲座"], [
    check("fixed_on_day2", (outcome) => card(outcome).visits.some((visit) => visit.role === "fixed" && visit.day === 2 &&
      visit.startsAt === "14:00" && visit.endsAt === "16:00" && names(visit.place).includes("云岭博物馆"))),
  ]),
  c("O12", "指定城市的兴趣", ["17号到19号，先在杭州玩一天，再坐高铁去云岭，在云岭想吃海鲜"], [
    check("interest_in_yunling", (outcome) => card(outcome).interests.some((item) => /海鲜/.test(item.text) && item.city?.adcode === YUNLING.adcode)),
  ], fromHangzhou),
  c("O13", "每天都要的兴趣", ["17到19号在云岭，每天晚上找个地方喝一杯"], [
    check("per_day_interest", (outcome) => card(outcome).interests.some((item) => item.perDay === true && item.when === "evening")),
  ]),
  c("O14", "第一天轻松点：写进卡片", ["17到19号在云岭玩，第一天轻松点"], [
    check("easy_first_day", (outcome) => /第一天|首日|17/.test(card(outcome).notes ?? "") && /轻松|少|慢/.test(card(outcome).notes ?? "")),
  ]),
  c("O15", "跨城市却没有交通方式：要问", ["17号在杭州玩，18号到19号去云岭，只坐地铁公交"], [
    check("asks_how_to_get_there", (outcome, view) => !(view.transports ?? []).length && /怎么去|怎么过去|高铁|开车|自驾|飞机|交通/.test(last(outcome))),
  ], { ...fromHangzhou, heldOut: true }),
  c("O16", "留出：去程回程两段高铁，整趟一个住处", [
    "10月20日到22日去云岭，20号上午9点从杭州东站坐高铁，11点半到云岭南站，住云岭山居酒店，22号下午4点坐高铁从云岭南站回杭州",
  ], [
    dates("2026-10-20", "2026-10-22"), lodgingIs("云岭山居酒店", "云岭山居酒店"),
    check("two_trains", (_, view) => (view.transports ?? []).filter((item) => item.mode === "train").length === 2),
    transport("back_at_16", (item) => item.day === 3 && item.departAt === "16:00"),
  ], { ...fromHangzhou, heldOut: true }),
  c("O17", "留出：周末两天爬山看海，住客栈", ["这周六周日去云岭爬山看海，住青石客栈"], [
    dates("2026-10-17", "2026-10-18"), lodgingIs("青石客栈"),
    check("mountain_and_sea", (outcome) => {
      const text = [...card(outcome).interests.map((item) => item.text), ...card(outcome).visits.flatMap((visit) => names(visit.place))].join(" ");
      return /山/.test(text) && /海/.test(text);
    }),
  ], { heldOut: true }),
  c("O18", "留出：最后一天坐夜车回去", ["17号到19号在云岭，19号晚上坐夜车回杭州"], [
    transport("last_night_train", (item) => item.day === 3 && item.mode === "train" && item.arriveDay === "next"),
  ], { heldOut: true }),
];

export const OUTING_INTAKE_VERSION = "v211-outing-intake.v1";
export function outingIntakeDigest(): string {
  const shape = OUTING_INTAKE_CASES.map((item) => ({ ...item, checks: item.checks.map((one) => one.name) }));
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}
