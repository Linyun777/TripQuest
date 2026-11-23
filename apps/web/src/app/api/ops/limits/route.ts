import { opsLimitsApi } from "../../../ops/api";

const handle = opsLimitsApi();
export const PATCH = (request: Request) => handle(request);
