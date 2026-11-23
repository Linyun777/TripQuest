import { BOOKING, type DemoInterest, type DemoStop } from "./demo-schedule";

type TimeField = "departure" | "returnBy" | "resumeAt";
export type DemoInput = Partial<Record<TimeField, number>> & {
  booking?: true;
  interests?: DemoInterest[];
  replaceInterests?: true;
  namedStops?: DemoStop[];
  completedFirst?: true;
  atMarket?: true;
  replacement?: DemoInterest;
  replacementTarget?: DemoStop;
};
export type DemoTimePrompt = TimeField | "booking";

const clock = /(上午|早上|中午|下午|傍晚|晚上)?(\d{1,2}|[零一二两三四五六七八九十]{1,3})(?:[:：](\d{2})|点(?:(半)|(\d{1,2})分?)?)/u;
const digits = "零一二三四五六七八九";

function hourCount(text: string) {
  if (/^\d+$/u.test(text)) return Number(text);
  const normalized = text.replace("两", "二");
  if (normalized.length === 1 && normalized !== "十") return digits.indexOf(normalized);
  const tens = /^([一二])?十([一二三四五六七八九])?$/u.exec(normalized);
  return tens ? (tens[1] ? digits.indexOf(tens[1]) : 1) * 10 + (tens[2] ? digits.indexOf(tens[2]) : 0) : -1;
}

function readClock(text: string) {
  const match = clock.exec(text);
  if (!match) return null;
  const [raw, period, hourText, colonMinutes, half, pointMinutes] = match;
  let hour = hourCount(hourText);
  const minutes = half ? 30 : Number(colonMinutes ?? pointMinutes ?? 0);
  if (hour < 0 || hour > 23 || minutes > 59 || (period && (hour < 1 || hour > 12))) return null;
  if (period === "下午" || period === "傍晚" || period === "晚上" || (period === "中午" && hour < 3)) {
    hour = hour === 12 ? 12 : hour + 12;
  }
  return { minutes: hour * 60 + minutes, phrase: text.replace(raw, "{时刻}") };
}

type ParseResult = { kind: "parsed"; input: DemoInput } | { kind: "unknown" } | { kind: "booking" };

function interestOf(phrase: string): DemoInterest | undefined {
  const interest = phrase.replace(/^(?:也想|还想|更想|想要|想|喜欢|改成想|改成)/u, "");
  if (/^(?:吃|尝尝|尝|吃点)?(?:当地|本地|特色)?小吃$/u.test(interest)) return "food";
  if (/^(?:逛|看|看看|了解)?(?:当地文化|人文|人文展览|人文体验|展馆)$/u.test(interest)) return "culture";
  if (/^(?:(?:沿湖|湖边)(?:散步|走走)|看湖景|看看湖景)$/u.test(interest)) return "lake";
  if (/^(?:喝茶(?:休息)?|找(?:一家)?茶馆|茶馆)$/u.test(interest)) return "tea";
}

/** This scene has a small, explicit vocabulary. Unrecognized clauses never silently edit a plan. */
export function readDemoInput(text: string, waitingFor: DemoTimePrompt | null): ParseResult {
  const input: DemoInput = {};
  const clauses = text.split(/[，,。！？!?；;\n]+/u).map((part) => part.replace(/\s+/gu, "")).filter(Boolean);
  if (clauses.length === 0) return { kind: "unknown" };

  function setTime(field: TimeField, time: number) {
    if (input[field] !== undefined && input[field] !== time) return false;
    input[field] = time;
    return true;
  }

  for (const clause of clauses) {
    const plain = clause.replace(/^(?:我(?:们)?|请)(?=.)/u, "");
    const time = readClock(plain);
    const phrase = time?.phrase ?? plain;

    if (time && /^(?:想|要|改成|改到|准备)?(?:从(?:松风湖)?游客中心)?\{时刻\}(?:从(?:松风湖)?游客中心)?出发(?:吧)?$/u.test(phrase)) {
      if (!setTime("departure", time.minutes)) return { kind: "unknown" };
    } else if (time && /^(?:最晚|要|得)?\{时刻\}(?:前|之前|以前)(?:到|到达|赶到|回到)(?:松风湖站|车站)?$/u.test(phrase)) {
      if (!setTime("returnBy", time.minutes)) return { kind: "unknown" };
    } else if (time && /^(?:(?:现在|已经)\{时刻\}(?:(?:还)?在(?:这里|第一站|(?:松风)?市集(?:门口)?))?|\{时刻\}(?:才|就)?(?:能|可以)?(?:从(?:这里|第一站|(?:松风)?市集)(?:继续|出发|离开|走)|离开(?:松风)?市集))$/u.test(phrase)) {
      if (!setTime("resumeAt", time.minutes)) return { kind: "unknown" };
      if (plain.includes("市集")) input.atMarket = true;
    } else if (time && phrase === "{时刻}" && waitingFor) {
      if (waitingFor === "booking") {
        if (time.minutes !== BOOKING.startsAt) return { kind: "booking" };
        input.booking = true;
      } else if (!setTime(waitingFor, time.minutes)) {
        return { kind: "unknown" };
      }
    } else if (time && /^\{时刻\}(?:有|预约了|有个|预订了)(?:一小时|1小时)?(?:湖畔)?(?:博物馆)?导览(?:预约)?$/u.test(phrase)) {
      if (time.minutes !== BOOKING.startsAt) return { kind: "booking" };
      input.booking = true;
    } else if (/^(?:想|也想|还想)?(?:去|逛|看看|逛逛)?(?:松风)?市集(?:(?:和|、|以及)(?:临湖)?书店)?$/u.test(plain)) {
      (input.namedStops ??= []).push("market");
      if (plain.endsWith("书店")) input.namedStops.push("books");
    } else if (/^(?:想|也想|还想)?(?:再)?(?:去|逛|看看|逛逛)?(?:临湖)?书店(?:也想去)?$/u.test(plain)) {
      (input.namedStops ??= []).push("books");
    } else if (/^(?:最后|结束后|再)?(?:到|到达|回到)(?:松风湖站|车站)$/u.test(plain)) {
      // The scenario ends at this station, independent of the arrival deadline.
    } else if (/^(?:(?:松风)?市集(?:已经)?逛完了?|逛完了?(?:松风)?市集|(?:已经)?结束(?:了)?(?:松风)?市集)$/u.test(plain)) {
      input.completedFirst = true;
      input.atMarket = true;
    } else if (/^(?:第一站(?:已经)?(?:逛完|完成)了?|逛完了?第一站)$/u.test(plain)) {
      input.completedFirst = true;
    } else if (/^(?:(?:湖畔|博物馆|湖畔博物馆|14点|14:00)?导览(?:别动|保留|不变|不改|照旧)|(?:保留|不改)(?:湖畔|博物馆|14点|14:00)?导览)$/u.test(plain)) {
      // Acknowledge the fixed commitment without changing its time.
    } else {
      const replacement = /^(?:想|能不能|可以)?(?:把)?(下一站|剩下那站|(?:临湖)?书店)(?:想)?换(?:成|为)?(?:一家|个)?(?:更近的)?(.+?)(?:吧|吗)?$/u.exec(plain);
      if (replacement) {
        const interest = interestOf(replacement[2]);
        if (!interest || (input.replacement && input.replacement !== interest)) return { kind: "unknown" };
        input.replacement = interest;
        if (replacement[1].endsWith("书店")) input.replacementTarget = "books";
        continue;
      }
      const interests = plain.split(/(?:和|以及|、)/u).map(interestOf);
      if (/^(?:改成|更想)/u.test(plain)) input.replaceInterests = true;
      for (const interest of interests) {
        if (!interest) return { kind: "unknown" };
        (input.interests ??= []).push(interest);
      }
    }
  }
  return { kind: "parsed", input };
}
