import { createHash } from "node:crypto";
import type { Assessment, JudgeInput, JudgeNeed, NeedStatus } from "@tripquest/agent/outing-judge";

/**
 * V4.7 第 1 步闸门（stages/V4.7.md §4.1）：18 个人造方案（地点都是虚构的），答案事先标好，看 outing-judge 准不准，不用规划。
 * 5 个完全没问题的、6 个没满足需求或和偏好冲突的、4 个整体问题（连续同类、错过饭点、来回绕、太满）、3 个店名看不出来的。
 * J05、J11、J15、J18 留出（改提示词时不看）。v1 在第一次跑模型之前写好并锁定。v2（2026-11-09，闸门第一次没过，用户定）：18 题和
 * 判分都不变，饭点、连续同类改由代码找、合并进判断结果，所以 J12、J13 考的是代码；留出题 v1 时已经跑过一次，不再算没看过的。
 *
 * 判分：
 * - 埋下的问题被找出：need 那一条的状态在 accept 里；issue 是这一天有这种 major 问题；said 是原话里的要求被提出来且没满足
 *   （extra 的状态 unmet / partly），或这一天有 major 问题。
 * - 误报：clean 的方案出现 unmet 或 major。
 * - 看不出来的：unknowable 那一条被判成 met。
 * - 结论（看 3 次是否一致）：unmet 的需求编号，加有没有 major 问题。
 */
export type Planted =
  | { readonly need: string; readonly accept: readonly NeedStatus[] }
  | { readonly issue: "pace" | "monotony" | "meal" | "detour"; readonly day: number }
  | { readonly said: true; readonly day: number };

export interface JudgeCase {
  readonly id: string;
  readonly note: string;
  readonly input: JudgeInput;
  readonly planted: readonly Planted[];
  readonly clean?: true;
  readonly unknowable?: string;
  readonly heldOut?: true;
}

type Stop = readonly [name: string, from: string, to: string, type: string, outdoor: boolean, travelMinutes?: number];
interface Day {
  readonly stops: readonly Stop[];
  readonly lodging?: string;
  readonly weather?: string;
  readonly transfers?: JudgeInput["days"][number]["transfers"];
}

const interest = (id: string, text: string): JudgeNeed => ({ id, source: "card", kind: "interest", scope: "stop", text });
const must = (id: string, text: string): JudgeNeed => ({ id, source: "card", kind: "must", scope: "stop", text });
const pace = (id: string, word: "轻松" | "标准"): JudgeNeed => ({ id, source: "card", kind: "pace", scope: "trip", text: `节奏：${word}` });
const notes = (id: string, text: string): JudgeNeed => ({ id, source: "card", kind: "notes", scope: "trip", text });
const saved = (id: string, text: string): JudgeNeed => ({ id, source: "saved", kind: "preference", scope: "trip", text });

/** 站点编号整趟连续（s1、s2…），日期从 10 月 24 日起。 */
function plan(needs: readonly JudgeNeed[], said: readonly string[], days: readonly Day[]): JudgeInput {
  let next = 0;
  return {
    needs: [...needs],
    said: [...said],
    found: [],
    days: days.map((day, index) => ({
      day: index + 1,
      date: `2026-10-${24 + index}`,
      ...(day.lodging ? { lodging: day.lodging } : {}),
      ...(day.weather ? { weather: day.weather } : {}),
      stops: day.stops.map(([name, from, to, type, outdoor, travelMinutes]) => {
        next += 1;
        return { ref: `s${next}`, name, from, to, type, outdoor, ...(travelMinutes === undefined ? {} : { travelMinutes }) };
      }),
      transfers: [...(day.transfers ?? [])],
    })),
  };
}

const train = (from: string, to: string, departAt: string, arriveAt: string) => ({ mode: "高铁", from, to, departAt, arriveAt });
const c = (id: string, note: string, input: JudgeInput, planted: readonly Planted[], extra: Partial<JudgeCase> = {}): JudgeCase =>
  ({ id, note, input, planted, ...extra });

export const JUDGE_DATASET_VERSION = "v47-judge.v2";

export const JUDGE_CASES: readonly JudgeCase[] = [
  c("J01", "没问题：两天，看灯塔、吃海鲜", plan([interest("n1", "看灯塔"), interest("n2", "吃海鲜"), pace("n3", "标准")], ["10月24日到25日去海澄玩两天，想看灯塔，吃点海鲜"], [
    { lodging: "海澄望海酒店", transfers: [train("杭州东站", "海澄站", "07:30", "09:00")], stops: [
      ["海澄灯塔", "09:40", "11:10", "景点", true, 30],
      ["渔港海鲜楼", "11:45", "12:55", "餐厅", false, 25],
      ["海澄老街", "13:30", "15:30", "步行街", true, 30],
      ["海岸咖啡", "15:50", "16:40", "咖啡厅", false, 15],
      ["望海餐厅", "18:00", "19:10", "餐厅", false, 20],
    ] },
    { transfers: [train("海澄站", "杭州东站", "17:00", "18:30")], stops: [
      ["海洋博物馆", "09:30", "11:30", "博物馆", false, 20],
      ["码头小馆", "12:00", "13:00", "餐厅", false, 15],
      ["滨海公园", "13:30", "15:30", "公园", true, 15],
    ] },
  ]), [], { clean: true }),
  c("J02", "没问题：三天轻松，逛老街、喝茶", plan([interest("n1", "逛老街"), interest("n2", "喝茶"), pace("n3", "轻松")], ["想轻松点，逛逛老街，喝喝茶"], [
    { lodging: "松州客舍", stops: [
      ["松州老街", "10:00", "11:45", "步行街", true, 20],
      ["老街面馆", "12:00", "13:00", "餐厅", false, 10],
      ["竹影茶室", "14:00", "15:30", "茶馆", false, 15],
      ["河畔小厨", "18:00", "19:00", "餐厅", false, 15],
    ] },
    { lodging: "松州客舍", stops: [
      ["松州古城墙", "10:00", "11:30", "景点", true, 20],
      ["城根小馆", "12:00", "13:00", "餐厅", false, 10],
      ["松州博物馆", "14:30", "16:00", "博物馆", false, 25],
      ["桂花酒家", "18:00", "19:00", "餐厅", false, 15],
    ] },
    { stops: [
      ["清溪公园", "10:00", "11:30", "公园", true, 20],
      ["溪边饭庄", "12:00", "13:00", "餐厅", false, 10],
      ["南门茶楼", "14:00", "15:30", "茶馆", false, 15],
    ] },
  ]), [], { clean: true }),
  c("J03", "没问题：每晚都有喝一杯的地方", plan([interest("n1", "每天晚上找个地方喝一杯"), pace("n2", "标准")], ["每天晚上想找个地方喝一杯"], [
    { lodging: "云岭山居", stops: [
      ["云岭博物馆", "09:30", "11:30", "博物馆", false, 20],
      ["山城小馆", "12:00", "13:00", "餐厅", false, 15],
      ["云岭花园", "13:40", "16:00", "公园", true, 20],
      ["岭下饭店", "18:00", "19:00", "餐厅", false, 15],
      ["月光小酒馆", "20:00", "21:00", "酒吧", false, 10],
    ] },
    { lodging: "云岭山居", stops: [
      ["青石古镇", "09:30", "11:45", "古镇", true, 30],
      ["古镇饭庄", "12:00", "13:00", "餐厅", false, 5],
      ["青石书院", "13:30", "15:30", "景点", false, 10],
      ["溪畔烧烤", "18:00", "19:00", "餐厅", false, 25],
      ["转角酒吧", "20:00", "21:00", "酒吧", false, 10],
    ] },
    { stops: [
      ["云岭南湖", "09:30", "11:30", "公园", true, 20],
      ["湖边小厨", "12:00", "13:00", "餐厅", false, 10],
    ] },
  ]), [], { clean: true }),
  c("J04", "没问题：带老人，少走路、不爬山", plan([interest("n1", "看园林"), notes("n2", "带老人，少走路，不爬山"), pace("n3", "轻松")], ["带我爸妈去，他们走不动太多路"], [
    { lodging: "岚溪宾馆", stops: [
      ["岚溪园林", "10:00", "11:30", "园林", true, 15],
      ["园外素菜馆", "12:00", "13:00", "餐厅", false, 10],
      ["岚溪博物馆", "14:00", "15:30", "博物馆", false, 15],
      ["老字号酒家", "17:30", "18:30", "餐厅", false, 10],
    ] },
    { stops: [
      ["水榭茶楼", "10:00", "11:30", "茶馆", false, 15],
      ["河鲜小馆", "12:00", "13:00", "餐厅", false, 10],
      ["岚溪水乡", "14:00", "15:30", "景点", true, 15],
    ] },
  ]), [], { clean: true }),
  c("J05", "留出，没问题：一天，看展", plan([interest("n1", "看展"), pace("n2", "标准")], ["这周六想看展"], [
    { stops: [
      ["城东美术馆", "10:00", "12:00", "美术馆", false, 25],
      ["馆前小馆", "12:15", "13:15", "餐厅", false, 5],
      ["当代艺术中心", "14:00", "16:00", "展览馆", false, 25],
      ["河坊咖啡", "16:20", "17:10", "咖啡厅", false, 10],
    ] },
  ]), [], { clean: true, heldOut: true }),

  c("J06", "没满足：想吃火锅，方案里没有", plan([interest("n1", "吃火锅"), interest("n2", "逛老街"), pace("n3", "标准")], ["想逛老街，晚上吃火锅"], [
    { lodging: "松州客舍", stops: [
      ["松州老街", "09:30", "11:45", "步行街", true, 20],
      ["老街面馆", "12:00", "13:00", "餐厅", false, 10],
      ["松州博物馆", "13:40", "15:40", "博物馆", false, 25],
      ["粤香茶餐厅", "18:00", "19:10", "餐厅", false, 15],
    ] },
    { stops: [
      ["清溪公园", "09:30", "11:30", "公园", true, 20],
      ["溪边饭庄", "12:00", "13:00", "餐厅", false, 10],
    ] },
  ]), [{ need: "n1", accept: ["unmet"] }]),
  c("J07", "没满足：每晚喝一杯，第 2 晚没有", plan([interest("n1", "每天晚上找个地方喝一杯"), pace("n2", "标准")], ["每天晚上想找个地方喝一杯"], [
    { lodging: "海澄望海酒店", stops: [
      ["海洋博物馆", "09:30", "11:30", "博物馆", false, 20],
      ["码头小馆", "12:00", "13:00", "餐厅", false, 15],
      ["滨海公园", "13:40", "16:00", "公园", true, 20],
      ["望海餐厅", "18:00", "19:00", "餐厅", false, 15],
      ["潮声小酒馆", "20:00", "21:00", "酒吧", false, 10],
    ] },
    { lodging: "海澄望海酒店", stops: [
      ["海澄灯塔", "09:30", "11:30", "景点", true, 30],
      ["渔港海鲜楼", "12:00", "13:00", "餐厅", false, 25],
      ["海澄老街", "13:40", "16:00", "步行街", true, 30],
      ["老街饭店", "18:00", "19:00", "餐厅", false, 10],
    ] },
    { stops: [
      ["南沙湾", "09:30", "11:30", "海滩", true, 25],
      ["沙湾小厨", "12:00", "13:00", "餐厅", false, 10],
    ] },
  ]), [{ need: "n1", accept: ["unmet", "partly"] }]),
  c("J08", "没满足：必去的云岭寺没排", plan([must("n1", "云岭寺"), interest("n2", "看风景"), pace("n3", "标准")], ["一定要去云岭寺"], [
    { lodging: "云岭山居", stops: [
      ["云岭花园", "09:30", "11:45", "公园", true, 20],
      ["山城小馆", "12:00", "13:00", "餐厅", false, 15],
      ["云岭博物馆", "13:40", "15:40", "博物馆", false, 20],
      ["岭下饭店", "18:00", "19:00", "餐厅", false, 15],
    ] },
    { stops: [
      ["云岭南湖", "09:30", "11:30", "公园", true, 20],
      ["湖边小厨", "12:00", "13:00", "餐厅", false, 10],
    ] },
  ]), [{ need: "n1", accept: ["unmet"] }]),
  c("J09", "没满足：想看日出，排在下午两点", plan([interest("n1", "在观日崖看日出"), pace("n2", "标准")], ["想去观日崖看日出"], [
    { lodging: "云岭山居", stops: [
      ["云岭博物馆", "09:30", "11:30", "博物馆", false, 20],
      ["山城小馆", "12:00", "13:00", "餐厅", false, 15],
      ["观日崖", "14:00", "15:00", "景点", true, 40],
      ["岭下饭店", "18:00", "19:00", "餐厅", false, 30],
    ] },
    { stops: [
      ["云岭南湖", "09:30", "11:30", "公园", true, 20],
      ["湖边小厨", "12:00", "13:00", "餐厅", false, 10],
    ] },
  ]), [{ need: "n1", accept: ["unmet", "partly"] }]),
  c("J10", "和长期偏好冲突：不爱爬山，排了登顶", plan([interest("n1", "看风景"), saved("p1", "不爱爬山，别安排登山"), pace("n2", "标准")], ["想看看风景"], [
    { lodging: "云岭山居", stops: [
      ["云岭山主峰登山步道", "08:30", "12:30", "山岳", true, 40],
      ["山脚小馆", "12:50", "13:50", "餐厅", false, 10],
      ["云岭花园", "14:30", "16:00", "公园", true, 20],
      ["岭下饭店", "18:00", "19:00", "餐厅", false, 15],
    ] },
    { stops: [
      ["云岭南湖", "09:30", "11:30", "公园", true, 20],
      ["湖边小厨", "12:00", "13:00", "餐厅", false, 10],
    ] },
  ]), [{ need: "p1", accept: ["unmet"] }]),
  c("J11", "留出，原话里的要求：别爬山，卡片上没有，排了爬山", plan([interest("n1", "看风景"), pace("n2", "标准")], ["想看看风景", "我妈腿不好，别安排爬山"], [
    { lodging: "青石客栈", stops: [
      ["青石岭登山步道", "08:30", "12:00", "山岳", true, 30],
      ["岭下小馆", "12:20", "13:20", "餐厅", false, 10],
      ["青石古镇", "14:00", "16:00", "古镇", true, 20],
      ["古镇饭庄", "18:00", "19:00", "餐厅", false, 10],
    ] },
    { stops: [
      ["青石书院", "09:30", "11:30", "景点", false, 15],
      ["书院素斋", "12:00", "13:00", "餐厅", false, 5],
    ] },
  ]), [{ said: true, day: 1 }], { heldOut: true }),

  c("J12", "整体问题：一天连着四座寺", plan([interest("n1", "看寺庙"), pace("n2", "标准")], ["想看看寺庙"], [
    { lodging: "松州客舍", stops: [
      ["净慈古寺", "09:00", "10:30", "寺庙", true, 15],
      ["灵泉禅寺", "10:50", "12:00", "寺庙", true, 15],
      ["素面小馆", "12:15", "13:00", "餐厅", false, 10],
      ["法云寺", "13:15", "14:30", "寺庙", true, 15],
      ["慈光禅院", "14:50", "16:00", "寺庙", true, 15],
      ["南山寺", "16:20", "17:30", "寺庙", true, 15],
      ["山门饭店", "18:00", "19:00", "餐厅", false, 10],
    ] },
    { stops: [
      ["松州博物馆", "09:30", "11:30", "博物馆", false, 25],
      ["城根小馆", "12:00", "13:00", "餐厅", false, 10],
    ] },
  ]), [{ issue: "monotony", day: 1 }]),
  c("J13", "整体问题：14 点半还没吃午饭", plan([interest("n1", "看古迹"), pace("n2", "标准")], ["想看看古迹"], [
    { lodging: "松州客舍", stops: [
      ["松州博物馆", "09:30", "11:30", "博物馆", false, 25],
      ["松州古城墙", "11:50", "14:20", "景点", true, 20],
      ["老街面馆", "14:40", "15:20", "餐厅", false, 15],
      ["松州老街", "15:40", "17:30", "步行街", true, 10],
      ["桂花酒家", "18:00", "19:00", "餐厅", false, 15],
    ] },
    { stops: [
      ["清溪公园", "09:30", "11:30", "公园", true, 20],
      ["溪边饭庄", "12:00", "13:00", "餐厅", false, 10],
    ] },
  ]), [{ issue: "meal", day: 1 }]),
  c("J14", "整体问题：东岸西郊来回绕", plan([interest("n1", "逛逛景点"), pace("n2", "标准")], ["随便逛逛"], [
    { lodging: "海澄望海酒店", stops: [
      ["东岸灯塔", "09:00", "10:30", "景点", true, 20],
      ["西郊花园", "11:45", "12:45", "公园", true, 75],
      ["东岸渔村小馆", "14:00", "14:50", "餐厅", false, 75],
      ["西郊书院", "16:05", "17:15", "景点", false, 75],
      ["东岸海鲜楼", "18:30", "19:30", "餐厅", false, 75],
    ] },
    { stops: [
      ["海洋博物馆", "09:30", "11:30", "博物馆", false, 20],
      ["码头小馆", "12:00", "13:00", "餐厅", false, 15],
    ] },
  ]), [{ issue: "detour", day: 1 }]),
  c("J15", "留出，整体问题：说了轻松，一天排了七站到晚上", plan([interest("n1", "逛逛景点"), pace("n2", "轻松")], ["想轻松点，别太赶"], [
    { lodging: "岚溪宾馆", stops: [
      ["岚溪公园", "08:00", "09:15", "公园", true, 15],
      ["岚溪园林", "09:40", "11:00", "园林", true, 20],
      ["园外素菜馆", "11:30", "12:15", "餐厅", false, 10],
      ["岚溪博物馆", "12:40", "14:10", "博物馆", false, 20],
      ["岚溪水乡", "14:40", "16:30", "景点", true, 25],
      ["古桥步行街", "17:00", "18:30", "步行街", true, 25],
      ["老字号酒家", "18:50", "19:50", "餐厅", false, 15],
      ["夜游码头", "20:10", "21:30", "景点", true, 15],
    ] },
    { stops: [
      ["水榭茶楼", "10:00", "11:30", "茶馆", false, 15],
      ["河鲜小馆", "12:00", "13:00", "餐厅", false, 10],
    ] },
  ]), [{ issue: "pace", day: 1 }], { heldOut: true }),

  c("J16", "看不出来：不吃辣，店名判断不了", plan([interest("n1", "逛老街"), saved("p1", "不吃辣"), pace("n2", "标准")], ["想逛老街"], [
    { lodging: "松州客舍", stops: [
      ["松州老街", "09:30", "11:45", "步行街", true, 20],
      ["老街小馆", "12:00", "13:00", "餐厅", false, 10],
      ["松州博物馆", "13:40", "15:40", "博物馆", false, 25],
      ["渔家菜馆", "18:00", "19:10", "餐厅", false, 15],
    ] },
    { stops: [
      ["清溪公园", "09:30", "11:30", "公园", true, 20],
      ["溪边饭庄", "12:00", "13:00", "餐厅", false, 10],
    ] },
  ]), [], { unknowable: "p1" }),
  c("J17", "看不出来：要安静的咖啡馆", plan([interest("n1", "找家安静的咖啡馆坐坐"), interest("n2", "看展"), pace("n3", "标准")], ["想看展，再找家安静的咖啡馆坐坐"], [
    { stops: [
      ["城东美术馆", "10:00", "12:00", "美术馆", false, 25],
      ["馆前小馆", "12:15", "13:15", "餐厅", false, 5],
      ["拐角咖啡", "14:00", "15:30", "咖啡厅", false, 20],
      ["河坊步行街", "16:00", "17:30", "步行街", true, 15],
    ] },
  ]), [], { unknowable: "n1" }),
  c("J18", "留出，看不出来：晚饭人均 100 以内", plan([interest("n1", "看江景"), notes("n2", "晚饭人均 100 以内"), pace("n3", "标准")], ["想看江景，晚饭别太贵，人均 100 以内"], [
    { stops: [
      ["江滨公园", "10:00", "12:00", "公园", true, 20],
      ["江边小厨", "12:15", "13:15", "餐厅", false, 10],
      ["观江楼", "14:00", "16:00", "景点", true, 20],
      ["望江餐厅", "18:00", "19:10", "餐厅", false, 15],
    ] },
  ]), [], { unknowable: "n2", heldOut: true }),
];

/** 这一个埋下的问题这次被找出来了没有。 */
function foundPlanted(planted: Planted, result: Assessment): boolean {
  if ("need" in planted) return result.needs.some((need) => need.id === planted.need && planted.accept.includes(need.status));
  if ("issue" in planted) return result.issues.some((issue) => issue.kind === planted.issue && issue.day === planted.day && issue.severity === "major");
  const raised = result.extra.some((item) => item.status === "unmet" || item.status === "partly");
  return raised || result.issues.some((issue) => issue.day === planted.day && issue.severity === "major");
}

export interface JudgeScore {
  readonly found: readonly boolean[];
  readonly falseAlarm: boolean;
  readonly unknownAsMet: boolean;
  /** 校验后还引用不存在的天或站点的条数。 */
  readonly badRefs: number;
  readonly conclusion: string;
}

export function scoreJudgment(item: JudgeCase, result: Assessment): JudgeScore {
  const days = new Set(item.input.days.map((day) => day.day));
  const stops = new Set(item.input.days.flatMap((day) => day.stops.map((stop) => stop.ref)));
  const references = [...result.needs, ...result.extra, ...result.issues.map((issue) => ({ days: [issue.day], stops: issue.stops }))];
  const badRefs = references.reduce((total, entry) => total + entry.days.filter((day) => !days.has(day)).length + entry.stops.filter((stop) => !stops.has(stop)).length, 0);
  const unmet = result.needs.filter((need) => need.status === "unmet").map((need) => need.id).sort();
  const major = result.issues.some((issue) => issue.severity === "major");
  return {
    found: item.planted.map((planted) => foundPlanted(planted, result)),
    falseAlarm: !!item.clean && (unmet.length > 0 || major),
    unknownAsMet: !!item.unknowable && result.needs.some((need) => need.id === item.unknowable && need.status === "met"),
    badRefs,
    conclusion: `${unmet.join(",")}|${major ? "major" : "none"}`,
  };
}

export function judgeDigest(): string {
  return createHash("sha256").update(JSON.stringify({ version: JUDGE_DATASET_VERSION, cases: JUDGE_CASES })).digest("hex");
}
