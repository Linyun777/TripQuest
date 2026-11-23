import { opsApi } from "../../../ops/api";

const handle = opsApi("users");
export const GET = (request: Request) => handle(request);
