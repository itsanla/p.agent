"use client";

import { useEffect, useRef, useState } from "react";
import { ChatBubble } from "@/components/chat-bubble";
import { fetchHistory, sendChat } from "@/lib/api";
import type { Message } from "@/lib/types";

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetchHistory()
      .then(setMessages)
      .catch(() => setError("Gagal memuat riwayat."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    setInput("");
    setError(null);
    setSending(true);
    const userMsg: Message = { role: "user", content: text, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const res = await sendChat(text);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: res.reply, timestamp: res.timestamp, keyUsed: res.keyUsed, modelUsed: res.model },
      ]);
    } catch {
      setError("Gagal mengirim pesan. Coba lagi.");
      setMessages((prev) => prev.filter((m) => m !== userMsg));
      setInput(text);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto flex h-[100dvh] max-w-3xl flex-col px-4 py-4 sm:px-6">
      <header className="mb-3 shrink-0">
        <h1 className="text-xl font-semibold tracking-tight">Chat dengan Linda</h1>
        <p className="text-sm text-muted">Percakapan ini berbagi memori dengan WhatsApp-mu.</p>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto rounded-xl border border-border bg-surface p-4">
        {loading && <p className="text-sm text-muted">Memuat riwayat…</p>}
        {!loading && messages.length === 0 && (
          <p className="text-sm text-muted">Belum ada percakapan. Sapa Linda untuk memulai 👋</p>
        )}
        {messages.map((m, i) => (
          <ChatBubble key={i} message={m} />
        ))}
        {sending && (
          <div className="flex justify-end">
            <div className="rounded-2xl rounded-br-sm bg-emerald-600/60 px-4 py-2 text-sm text-white">
              Linda mengetik…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <form onSubmit={send} className="mt-3 flex shrink-0 gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tulis pesan…"
          disabled={sending}
          className="flex-1 rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm outline-none focus:border-emerald-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          Kirim
        </button>
      </form>
    </div>
  );
}
