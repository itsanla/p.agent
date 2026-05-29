"use client";

import Link from "next/link";
import { maskPhone, timeAgo } from "@/lib/format";
import type { ChatMetadata } from "@/lib/types";

export function ConversationList({ chats }: { chats: ChatMetadata[] }) {
  if (chats.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface px-5 py-10 text-center text-muted">
        No conversations yet. Messages will appear here once your WhatsApp webhook receives them.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th className="px-5 py-3 font-medium">Phone</th>
            <th className="px-5 py-3 font-medium">Last message</th>
            <th className="hidden px-5 py-3 font-medium sm:table-cell">Messages</th>
            <th className="px-5 py-3 font-medium">Active</th>
          </tr>
        </thead>
        <tbody>
          {chats.map((chat) => (
            <tr
              key={chat.phone}
              className="border-b border-border last:border-0 transition-colors hover:bg-surface-2"
            >
              <td className="px-5 py-3">
                <Link
                  href={`/conversations/${encodeURIComponent(chat.phone)}`}
                  className="font-medium text-foreground hover:underline"
                >
                  {chat.name || maskPhone(chat.phone)}
                </Link>
                {chat.name && (
                  <div className="font-mono text-xs text-muted">{maskPhone(chat.phone)}</div>
                )}
              </td>
              <td className="max-w-xs truncate px-5 py-3 text-muted">
                {chat.lastMessage || "—"}
              </td>
              <td className="hidden px-5 py-3 tabular-nums text-muted sm:table-cell">
                {chat.totalMessages}
              </td>
              <td className="px-5 py-3 text-muted">{timeAgo(chat.lastActive)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
