import { describe, expect, it } from "vitest";
import { createJevClient, JevError, type JevQuestion } from "../jev";

const QUESTIONS: Record<string, JevQuestion> = {
  planning: { type: "noul", instructions: "Does the user want a day planned?" },
  stay: { type: "choice", instructions: "How long?", criteria: { "30": null, "60": null } },
};
const GOOD = {
  model: "jev-1.14.0",
  answers: {
    planning: { type: "noul", noul: 0.9 },
    stay: { type: "choice", choice: "60", confidence: 0.4, probabilities: { "30": 0.3, "60": 0.7 } },
  },
  usage: { input_tokens: 120, output_tokens: 10 },
};

function client(reply: () => Response | Promise<Response>, extra: { apiKey?: string; beforeRequest?: () => void; timeoutMs?: number } = {}) {
  const sent: RequestInit[] = [];
  const jev = createJevClient({
    apiKey: "apiKey" in extra ? extra.apiKey : "secret-key",
    fetch: (async (_url: string, init: RequestInit) => {
      sent.push(init);
      return reply();
    }) as typeof fetch,
    ...(extra.beforeRequest ? { beforeRequest: extra.beforeRequest } : {}),
    ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
  });
  return { jev, sent };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ask = (jev: ReturnType<typeof client>["jev"], signal = new AbortController().signal) => jev.ask({ message: "明天去灵隐寺" }, QUESTIONS, { signal });
const failure = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error instanceof JevError ? error : null));

describe("Jev client", () => {
  it("sends the pinned model and questions, and returns the answering version and tokens", async () => {
    const { jev, sent } = client(() => json(GOOD));
    const reply = await ask(jev);
    expect(reply).toEqual({ model: "jev-1.14.0", answers: GOOD.answers, inputTokens: 120 });
    const body = JSON.parse(String(sent[0].body));
    expect(body).toMatchObject({ model: "jev-1.14.0", state: { message: "明天去灵隐寺" }, questions: QUESTIONS });
    expect((sent[0].headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
  });

  it("refuses replies with a missing answer, a wrong type, a probability out of range or an unknown choice", async () => {
    const broken = [
      { ...GOOD, answers: { planning: GOOD.answers.planning } },
      { ...GOOD, answers: { ...GOOD.answers, planning: { type: "choice", choice: "60", confidence: 1, probabilities: {} } } },
      { ...GOOD, answers: { ...GOOD.answers, planning: { type: "noul", noul: 1.2 } } },
      { ...GOOD, answers: { ...GOOD.answers, stay: { ...GOOD.answers.stay, choice: "90" } } },
      { answers: GOOD.answers, usage: GOOD.usage },
    ];
    for (const body of broken) {
      expect((await failure(ask(client(() => json(body)).jev)))?.code).toBe("invalid_reply");
    }
  });

  it("maps failures to codes without the key, and stops before sending when there is no key or no daily budget", async () => {
    const codes = await Promise.all([
      failure(ask(client(() => json({ detail: "slow down" }, 429)).jev)),
      failure(ask(client(() => json({}, 401)).jev)),
      failure(ask(client(() => json({}, 529)).jev)),
      failure(ask(client(() => json({}, 500)).jev)),
      failure(ask(client(() => new Promise<Response>(() => {}), { timeoutMs: 20 }).jev)),
    ]);
    expect(codes.map((error) => error?.code)).toEqual(["rate_limited", "unauthorized", "overloaded", "http_500", "timeout"]);
    expect(codes.every((error) => !String(error?.message).includes("secret-key"))).toBe(true);

    const noKey = client(() => json(GOOD), { apiKey: undefined });
    expect((await failure(ask(noKey.jev)))?.code).toBe("no_key");
    const spent = client(() => json(GOOD), { beforeRequest: () => { throw new Error("limit"); } });
    expect((await failure(ask(spent.jev)))?.code).toBe("daily_limit");
    expect([...noKey.sent, ...spent.sent]).toHaveLength(0);

    const controller = new AbortController();
    controller.abort();
    expect((await failure(ask(client(() => json(GOOD)).jev, controller.signal)))?.code).toBe("cancelled");
  });
});
