import { opsApi } from "../../../ops/api";

const handle = opsApi("usage");
export const GET = (request: Request) => handle(request);
