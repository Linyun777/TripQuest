import { healthResponse } from "../../../deployment/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function GET() { return healthResponse(200); }
