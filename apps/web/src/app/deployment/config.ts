import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveProfile } from "@tripquest/agent/live";
import { readPrices, siteDailyLimit } from "@tripquest/db";

import { fixedExpenses } from "./fixed-expenses";

const required = (environment: NodeJS.ProcessEnv, name: string): string => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing deployment setting: ${name}`);
  return value;
};

/** Fail before accepting traffic. Errors name settings, never include their values. */
export async function validateProductionConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workspaceRoot = resolve(process.cwd(), "../.."),
): Promise<void> {
  if (environment.NODE_ENV !== "production") return;
  readPrices(environment.MODEL_PRICE_FILE);
  fixedExpenses(environment.FIXED_EXPENSE_FILE);
  const mode = environment.TRIPQUEST_DEPLOYMENT_MODE ?? "local";
  if (mode !== "local" && mode !== "invited") throw new Error("Invalid TRIPQUEST_DEPLOYMENT_MODE");
  try {
    const url = new URL(required(environment, "BETTER_AUTH_URL"));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error();
    }
  } catch {
    throw new Error("BETTER_AUTH_URL must be an HTTPS origin");
  }
  try {
    const url = new URL(required(environment, "DATABASE_URL"));
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.pathname.length < 2) throw new Error();
  } catch {
    throw new Error("Invalid DATABASE_URL");
  }
  siteDailyLimit("model", environment);
  const names = ["BETTER_AUTH_SECRET"];
  if (mode === "invited") names.push("PLANNING_PLACE_TOKEN_SECRET", "PLANNING_DRAFT_RECEIPT_SECRET");
  const secrets = names.map((name) => {
    const secret = required(environment, name);
    const length = name === "BETTER_AUTH_SECRET" ? secret.length : Buffer.byteLength(secret, "utf8");
    if (length < 32) throw new Error(`${name} is too short`);
    return secret;
  });
  if (new Set(secrets).size !== secrets.length) throw new Error("Deployment signing secrets must be distinct");
  if (mode !== "invited") return;

  for (const [name, value] of Object.entries({
    PLANNING_PLACE_SOURCE: "amap",
    REAL_PLACE_SAVE_ENABLED: "true",
    PLANNING_GENERATION_ENABLED: "true",
    PLANNING_AMAP_GENERATION_ENABLED: "true",
    PLANNING_MODEL_MODE: "live",
    AGENT_LIVE_ENABLED: "true",
    PLANNING_SAVE_ENABLED: "true",
  })) {
    if (environment[name] !== value) throw new Error(`Invalid invited deployment setting: ${name}`);
  }
  required(environment, "AMAP_WEB_SERVICE_KEY");
  if (environment.PLANNING_MAP_MODE === "amap") {
    required(environment, "AMAP_JS_API_KEY");
    required(environment, "AMAP_JS_SECURITY_CODE");
  }
  if (environment.WEB_SEARCH_ENABLED !== "false") required(environment, "DEEPSEEK_API_KEY");
  if (environment.KNOWLEDGE_ENABLED !== "false") required(environment, "DASHSCOPE_API_KEY");
  try {
    const profilePath = resolve(workspaceRoot, "agent-models.local.json");
    if ((await stat(profilePath)).size > 64 * 1024) throw new Error();
    const config: unknown = JSON.parse(await readFile(profilePath, "utf8"));
    const { apiKey } = resolveProfile(config, required(environment, "AGENT_MODEL_PROFILE"), environment);
    if (secrets.some((secret) => [apiKey, environment.AMAP_WEB_SERVICE_KEY, environment.DEEPSEEK_API_KEY].includes(secret))) {
      throw new Error();
    }
  } catch {
    throw new Error("Invalid model profile or model credential");
  }
}
