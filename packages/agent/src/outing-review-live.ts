import { createJsonDecisionTransport, type LiveModelOptions } from "./live";
import type { JudgeRequest } from "./outing-judge";
import type { ReviewRequest } from "./outing-review";

/** V3.2 审查 Agent 的模型请求（同一个 deepseek-flash；一次最多 4 条修改，1024 tokens 够用）。 */
export function createReviewRequest(options: LiveModelOptions): ReviewRequest {
  const transport = createJsonDecisionTransport({ ...options, outputTokenLimit: 1024 });
  return (system, content, signal) => transport.request(system, content, signal);
}

/** V4.7 整体判断的模型请求：判断比审查长，输出上限单独设 2048（配置缺省只有 512）。 */
export function createJudgeRequest(options: LiveModelOptions): JudgeRequest {
  const transport = createJsonDecisionTransport({ ...options, outputTokenLimit: 2048 });
  return (system, content, signal) => transport.request(system, content, signal);
}
