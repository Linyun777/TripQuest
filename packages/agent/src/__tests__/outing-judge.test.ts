import { describe, expect, it } from "vitest";
import { DecisionModelError } from "../contracts";
import { planningNotes } from "../outing-generate";
import { codeIssues, judgeOuting, judgeOutputSchema, judgeSaid, stopTypeLabel, validateJudgment, type JudgeInput, type JudgeRequest } from "../outing-judge";

const input: JudgeInput = {
  needs: [
    { id: "n1", source: "card", kind: "interest", scope: "stop", text: "吃火锅" },
    { id: "n2", source: "card", kind: "pace", scope: "trip", text: "节奏：轻松" },
    { id: "p1", source: "saved", kind: "preference", scope: "trip", text: "不吃辣" },
  ],
  said: ["晚上想吃火锅，我妈腿不好别爬山"],
  found: [],
  days: [{
    day: 1,
    date: "2026-10-24",
    stops: [{ ref: "s1", name: "合成火锅", from: "18:00", to: "19:00", type: "餐厅", outdoor: false }],
    transfers: [],
  }],
};
const judged = (fields: Record<string, unknown>) => validateJudgment(judgeOutputSchema.parse({ overall: 4, summary: "还行", needs: [], ...fields }), input);

describe("V4.7 checking the judgment against the plan", () => {
  it("drops what is not on the plan, downgrades a 'met' with nothing behind it, and marks unjudged needs unknown", () => {
    const result = judged({
      needs: [
        { id: "n1", status: "met", stops: ["s9"], days: [8] },
        { id: "n2", status: "met", days: [1] },
        { id: "x7", status: "unmet" },
      ],
      issues: [
        { kind: "meal", severity: "major", day: 5 },
        { kind: "pace", severity: "minor", day: 1, stops: ["s9"] },
        { kind: "mismatch", severity: "major", day: 1 },
        { kind: "mismatch", severity: "major", day: 1, need: "p1", stops: ["s1"] },
      ],
    });
    expect(result.needs.map((need) => [need.id, need.status, need.stops, need.days])).toEqual([
      ["n1", "unknown", [], []],
      ["n2", "met", [], [1]],
      ["p1", "unknown", [], []],
    ]);
    expect(result.issues).toEqual([{ kind: "mismatch", severity: "major", day: 1, stops: ["s1"], need: "p1", note: "" }]);
    expect(result.corrected).toMatchObject({ downgraded: 1, droppedIssues: 3, missingNeeds: 1 });
  });

  it("keeps an extra requirement only when its quote is word for word in what the traveller said", () => {
    const result = judged({
      extra: [
        { quote: "我妈腿不好别爬山", text: "别爬山", status: "unmet" },
        { quote: "我爸也不爬山", text: "别爬山", status: "unmet" },
      ],
    });
    expect(result.extra.map((item) => item.quote)).toEqual(["我妈腿不好别爬山"]);
    expect(result.corrected.droppedExtra).toBe(1);
  });
});

describe("V4.7 meals and same-type runs are worked out by code", () => {
  const stop = (ref: string, from: string, to: string, type: string) => ({ ref, name: `站${ref}`, from, to, type, outdoor: false });
  const onDay = (stops: JudgeInput["days"][number]["stops"]): JudgeInput => ({ ...input, days: [{ day: 1, date: "2026-10-24", stops, transfers: [] }] });

  it("finds a late lunch, not a day with no restaurant at all, and three stops of one specific type with a meal between", () => {
    expect(codeIssues(onDay([stop("s1", "09:30", "11:30", "博物馆"), stop("s2", "11:50", "14:20", "古迹"), stop("s3", "14:40", "15:20", "餐厅")])))
      .toEqual([{ kind: "meal", severity: "major", day: 1, stops: ["s3"], note: "午饭 14:40 才开始" }]);
    expect(codeIssues(onDay([stop("s1", "09:30", "12:00", "博物馆"), stop("s2", "13:00", "16:00", "公园")]))).toEqual([]);
    expect(codeIssues(onDay([stop("s1", "12:00", "12:40", "寺庙"), stop("s2", "12:50", "13:00", "寺庙"), stop("s3", "13:05", "13:40", "餐厅"), stop("s4", "13:50", "14:00", "寺庙")])))
      .toEqual([{ kind: "monotony", severity: "major", day: 1, stops: ["s1", "s2", "s4"], note: "连着 3 站都是寺庙" }]);
  });

  it("leaves a normal day alone, does not count a generic type, and drops the model's own meal and monotony issues", () => {
    expect(codeIssues(onDay([stop("s1", "09:30", "11:30", "景点"), stop("s2", "12:00", "13:00", "餐厅"), stop("s3", "13:30", "15:00", "景点"), stop("s4", "15:30", "16:30", "景点")]))).toEqual([]);
    expect(judged({ issues: [{ kind: "meal", severity: "major", day: 1 }, { kind: "monotony", severity: "major", day: 1 }] }).issues).toEqual([]);
  });
});

describe("V4.7 asking the model", () => {
  const replying = (...replies: unknown[]): JudgeRequest => async () => {
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return { decision: next } as never;
  };
  const signal = new AbortController().signal;

  it("asks once more after a malformed answer and accepts a null 'need'", async () => {
    const good = { overall: 3, summary: "一般", needs: [], issues: [{ kind: "pace", severity: "minor", day: 1, need: null }] };
    const result = await judgeOuting(replying({ overall: "好" }, good), input, signal);
    expect(result?.issues.map((issue) => issue.kind)).toEqual(["pace"]);
  });

  it("gives up without failing when the model errors or stays malformed", async () => {
    expect(await judgeOuting(replying(new DecisionModelError("timeout")), input, signal)).toBeNull();
    expect(await judgeOuting(replying({ overall: "好" }, { overall: "好" }), input, signal)).toBeNull();
  });
});

describe("V4.7 the need list and the planning notes", () => {
  it("adds saved preferences to the planning notes without running over, and keeps private messages out of what the judge sees", () => {
    expect(planningNotes({ notes: "少走路", preferences: ["不吃辣", "不爬山"] })).toBe("少走路。长期偏好：不吃辣；不爬山");
    expect(planningNotes({ preferences: ["长".repeat(600)] })!.length).toBe(400);
    expect(planningNotes({})).toBeUndefined();
    expect(judgeSaid(["想吃火锅", "我手机号 13812345678", "别太赶"])).toEqual(["想吃火锅", "别太赶"]);
    expect(judgeSaid(["早".repeat(1000), "晚".repeat(1000)])).toEqual(["晚".repeat(1000)]);
  });

  it("labels stops from the Amap code and refines generic sights by name", () => {
    expect([stopTypeLabel("050117", "老火锅"), stopTypeLabel("050500", "转角"), stopTypeLabel("080304", "小酒馆"), stopTypeLabel("140100", "省博")]).toEqual(["餐厅", "咖啡厅", "酒吧", "博物馆"]);
    expect([stopTypeLabel("110202", "灵隐寺"), stopTypeLabel("110202", "雷峰塔"), stopTypeLabel("110200|061000", "河坊街")]).toEqual(["寺庙", "景点", "景点"]);
  });
});
