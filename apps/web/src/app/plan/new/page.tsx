import { connection } from "next/server";
import { readPlanningMapConfig } from "../../journeys/map-config";
import { ChatController } from "../chat-controller";
import { DEFAULT_TITLE, readChatAvailability } from "../conversation-service";

export const runtime = "nodejs";

/** A conversation starts with its first message; `?q=` carries one from the home page. */
export default async function NewPlanPage({ searchParams }: { searchParams: Promise<{ q?: string; mode?: string }> }) {
  await connection();
  const { q, mode } = await searchParams;
  const initialText = typeof q === "string" && q.trim() ? q.trim().slice(0, 1000) : undefined;
  return (
    <ChatController
      conversationId={null}
      title={DEFAULT_TITLE}
      initialMessages={[]}
      messageCount={0}
      mapConfig={readPlanningMapConfig()}
      availability={readChatAvailability()}
      initialText={initialText}
      // V2.11：首页选了出游时，对话从出游卡片开始。
      initialMode={mode === "outing" ? "outing" : "daily"}
    />
  );
}
