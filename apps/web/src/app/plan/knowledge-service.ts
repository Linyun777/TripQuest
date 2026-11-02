import "server-only";
import { getSharedJourneyDatabase } from "@tripquest/db";
import { KnowledgeStore } from "@tripquest/rag";
import type { KnowledgePassageView } from "./view-models";

const CHUNK_ID = /^[a-z0-9-]{1,80}:\d{1,4}$/;

/** V2.8: a cited passage of our own knowledge base, read when the citation is opened. */
export async function readKnowledgePassage(
  chunkId: string,
  store: () => Pick<KnowledgeStore, "passage"> = () => new KnowledgeStore(getSharedJourneyDatabase().pool),
): Promise<{ status: "ok"; passage: KnowledgePassageView } | { status: "not_found" }> {
  if (!CHUNK_ID.test(chunkId)) return { status: "not_found" };
  const found = await store().passage(chunkId);
  if (!found) return { status: "not_found" };
  return {
    status: "ok",
    passage: {
      chunkId: found.id,
      title: found.title,
      headingPath: found.headingPath,
      text: found.body,
      sources: found.sources.map((source) => ({ url: source.url, note: source.note, accessed: source.accessed })),
    },
  };
}
