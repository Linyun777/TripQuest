import {
  REPLAN_STREAM_EVENT_BYTES,
  REPLAN_STREAM_TOTAL_BYTES,
  replanStreamEventSchema,
  type ReplanOffer,
  type ReplanProgress,
  type ReplanResult,
} from "@tripquest/application/day-replan-contract";

export type ReplanStreamOutcome =
  | { kind: "result"; result: ReplanResult; offer?: ReplanOffer }
  | { kind: "incomplete" };

/** Accepts only one complete, ordered run; anything else is "incomplete", never a partial plan. */
export async function readReplanStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (progress: ReplanProgress) => void,
): Promise<ReplanStreamOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let buffer = "";
  let total = 0;
  let expected = 0;
  let runId: string | null = null;
  let outcome: Extract<ReplanStreamOutcome, { kind: "result" }> | null = null;
  const accept = (line: string): boolean => {
    if (encoder.encode(line).byteLength > REPLAN_STREAM_EVENT_BYTES || outcome) return false;
    let parsed;
    try {
      parsed = replanStreamEventSchema.safeParse(JSON.parse(line));
    } catch {
      return false;
    }
    if (!parsed.success || parsed.data.sequence !== expected) return false;
    const event = parsed.data;
    expected += 1;
    if (event.type === "started") {
      runId = event.runId;
      return true;
    }
    if (event.runId !== runId) return false;
    if (event.type === "progress") onProgress(event.progress);
    else outcome = { kind: "result", result: event.result, ...(event.offer ? { offer: event.offer } : {}) };
    return true;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > REPLAN_STREAM_TOTAL_BYTES) throw new Error("stream_limit");
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        if (!accept(buffer.slice(0, newline))) throw new Error("invalid_event");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (encoder.encode(buffer).byteLength > REPLAN_STREAM_EVENT_BYTES) throw new Error("event_limit");
    }
    buffer += decoder.decode();
  } catch {
    await reader.cancel().catch(() => {});
    return { kind: "incomplete" };
  }
  return outcome && !buffer ? outcome : { kind: "incomplete" };
}
