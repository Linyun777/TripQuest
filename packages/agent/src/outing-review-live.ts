import { createJsonDecisionTransport, type LiveModelOptions } from "./live";
import type { ReviewRequest } from "./outing-review";

/** V3.2 审查 Agent 的模型请求（同一个 deepseek-flash；一次最多 4 条修改，1024 tokens 够用）。 */
export function createReviewRequest(options: LiveModelOptions): ReviewRequest {
  const transport = createJsonDecisionTransport({ ...options, outputTokenLimit: 1024 });
  return (system, content, signal) => transport.request(system, content, signal);
}
