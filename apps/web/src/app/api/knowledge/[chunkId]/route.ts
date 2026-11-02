import { withUser } from "../../../auth/session";
import { readKnowledgePassage } from "../../../plan/knowledge-service";

export const runtime = "nodejs";

/** V2.8: the text of one cited knowledge-base passage (our own corpus, safe to show as is). */
export const GET = withUser<{ params: Promise<{ chunkId: string }> }>({}, async (_request, _user, context) => {
  const { chunkId } = await context.params;
  try {
    const reply = await readKnowledgePassage(decodeURIComponent(chunkId));
    if (reply.status !== "ok") return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(reply.passage, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
});
