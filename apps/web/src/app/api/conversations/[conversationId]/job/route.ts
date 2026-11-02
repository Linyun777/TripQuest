import { createJobHandler } from "../../plan-handlers";

export const runtime = "nodejs";
// 接上一趟出游的生成，可能要跟着推好几分钟。
export const maxDuration = 600;
export const GET = createJobHandler();
