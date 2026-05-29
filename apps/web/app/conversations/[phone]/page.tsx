"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ChatBubble } from "@/components/chat-bubble";
import { maskPhone } from "@/lib/format";
import type { Message } from "@/lib/types";

export default function ConversationDetailPage() {
  const params = useParams<{ phone: string }>();
  const router = useRouter();
  const phone = decodeURIComponent(params.phone);

  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(phone)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const json = (await res.json()) as { messages: Message[] };
      setMessages(json.messages);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load conversation");
    }
  }, [phone]);

  useEffect(() => {
    // async fetch → setState resolves after await, not synchronously
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    void load();
  }, [load]);

  const clearHistory = useCallback(async () => {
    if (!confirm("Clear this conversation history? This cannot be undone.")) return;
    setClearing(true);
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(phone)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      router.push("/conversations");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear conversation");
      setClearing(false);
    }
  }, [phone, router]);

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col px-5 py-8 sm:px-8">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div>
          <Link href="/conversations" className="text-sm text-muted hover:underline">
            ← Conversations
          </Link>
          <h1 className="font-mono text-xl font-semibold tracking-tight">{maskPhone(phone)}</h1>
        </div>
        <button
          onClick={clearHistory}
          disabled={clearing}
          className="rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
        >
          {clearing ? "Clearing…" : "Clear history"}
        </button>
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto rounded-xl border border-border bg-surface p-4">
        {!messages && !error && <p className="text-muted">Loading…</p>}
        {messages && messages.length === 0 && (
          <p className="py-10 text-center text-muted">No messages in this conversation.</p>
        )}
        {messages?.map((m, i) => (
          <ChatBubble key={`${m.timestamp}-${i}`} message={m} />
        ))}
      </div>
    </div>
  );
}
