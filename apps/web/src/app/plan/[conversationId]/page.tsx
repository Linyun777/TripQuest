import { notFound } from "next/navigation";
import { connection } from "next/server";
import { readPlanningMapConfig } from "../../journeys/map-config";
import { ChatController } from "../chat-controller";
import { createConversationService, readChatAvailability } from "../conversation-service";
import { createTripProgressService } from "../trip-progress-service";
import { pageUser } from "../../auth/session";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  await connection();
  const { conversationId } = await params;
  if (!UUID.test(conversationId)) notFound();
  const user = await pageUser(`/plan/${conversationId}`);
  const found = await createConversationService({ userId: user.id }).view(conversationId);
  if (!found) notFound();
  // V2.5: the saved trip's progress; the panel loads it itself if this read fails.
  const journeyId = found.conversation.journeyId;
  const trip = journeyId
    ? await createTripProgressService({ userId: user.id }).load(journeyId, found.conversation.id).catch(() => null)
    : null;
  return (
    <ChatController
      // 刷新后消息数变了（跨天改动保存、别处有新消息）就重新挂载，换成服务端的消息。
      key={`${found.conversation.id}-${found.conversation.messageCount}`}
      conversationId={found.conversation.id}
      title={found.conversation.title}
      initialMessages={found.messages}
      messageCount={found.conversation.messageCount}
      mapConfig={readPlanningMapConfig()}
      availability={readChatAvailability()}
      latestPlan={found.latestPlan}
      journeyId={trip ? journeyId : null}
      initialTrip={trip}
    />
  );
}
