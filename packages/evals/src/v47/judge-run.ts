import { judgeOuting, judgeOutputSchema, type Assessment, type JudgeRequest } from "@tripquest/agent/outing-judge";
import { scoreJudgment, type JudgeCase, type JudgeScore } from "./judge-dataset";

/** V4.7 §4.1：一个人造方案判断一次。模型出错或两次都不合格时 assessment 为 null（按什么都没找到算）。 */
export interface JudgeRow {
  readonly caseId: string;
  readonly heldOut: boolean;
  readonly failed: boolean;
  readonly score: JudgeScore | null;
  readonly assessment: Assessment | null;
  readonly ms: number;
  /** 判断失败时最后一次回答哪里不合格（字段路径和问题，不带内容）；模型出错时是 model_error。 */
  readonly invalid?: string;
}

export async function runJudgeCase(item: JudgeCase, request: JudgeRequest): Promise<JudgeRow> {
  const started = performance.now();
  let last: unknown;
  let requestError = false;
  const recording: JudgeRequest = async (system, content, signal) => {
    try {
      const reply = await request(system, content, signal);
      last = reply.decision;
      return reply;
    } catch (error) {
      requestError = true;
      throw error;
    }
  };
  const assessment = await judgeOuting(recording, item.input, AbortSignal.timeout(30_000));
  const parsed = assessment ? null : judgeOutputSchema.safeParse(last);
  const invalid = requestError ? "model_error" : parsed && !parsed.success ? parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.code}`).join("; ") : undefined;
  return {
    caseId: item.id,
    heldOut: !!item.heldOut,
    failed: !assessment,
    score: assessment ? scoreJudgment(item, assessment) : null,
    assessment,
    ms: Math.round(performance.now() - started),
    ...(invalid ? { invalid } : {}),
  };
}
