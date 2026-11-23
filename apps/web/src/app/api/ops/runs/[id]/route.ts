import { opsApi } from "../../../../ops/api";

const handle = opsApi("detail");
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, (await context.params).id);
}
