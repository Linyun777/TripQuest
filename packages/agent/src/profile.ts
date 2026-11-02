import { z } from "zod";

const profileSchema = z.object({
  providerId: z.string().regex(/^[a-z0-9-]{1,64}$/),
  adapter: z.literal("chat_completions"),
  baseURL: z.string().url(),
  model: z.string().regex(/^[A-Za-z0-9_.:/-]{1,128}$/),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
  jsonMode: z.literal("json_object"),
  thinkingMode: z.enum(["disabled", "omit"]),
  temperature: z.literal(0),
  outputTokenLimit: z.literal(512),
}).strict();
const profilesSchema = z.object({
  version: z.literal(1),
  profiles: z.record(z.string().regex(/^[a-z0-9-]{1,64}$/), profileSchema),
}).strict();
export type ModelProfile = z.infer<typeof profileSchema>;

export function resolveProfile(
  config: unknown,
  id: string,
  environment: Readonly<Record<string, string | undefined>>,
  allowLoopback = false,
): { profile: Readonly<ModelProfile>; apiKey: string } {
  const parsed = profilesSchema.safeParse(config);
  if (!parsed.success || !Object.hasOwn(parsed.data.profiles, id)) {
    throw new Error("Invalid model profile configuration");
  }
  const profile = parsed.data.profiles[id];
  const url = new URL(profile.baseURL);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:"))
  ) throw new Error("Unsupported model endpoint");
  if (profile.thinkingMode === "disabled" && profile.providerId !== "deepseek") {
    throw new Error("Thinking extension requires the DeepSeek profile mapping");
  }
  const apiKey = environment[profile.apiKeyEnv];
  if (!apiKey?.trim()) throw new Error("Missing model credential");
  return { profile: Object.freeze({ ...profile }), apiKey };
}
