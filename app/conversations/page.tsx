import { ConversationList } from "@/components/conversation-list";
import { getAllActiveChats } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ConversationsPage() {
  let chats = [] as Awaited<ReturnType<typeof getAllActiveChats>>;
  let error: string | null = null;
  try {
    chats = await getAllActiveChats();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load conversations";
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Conversations</h1>
        <p className="text-sm text-muted">{chats.length} active conversation(s)</p>
      </header>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      ) : (
        <ConversationList chats={chats} />
      )}
    </div>
  );
}
