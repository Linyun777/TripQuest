import { opsApi } from "../../../ops/api";

const handle = opsApi("runs");
export const GET = (request: Request) => handle(request);
