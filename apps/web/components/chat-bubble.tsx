import { formatTime } from "@/lib/format";
import type { Message } from "@/lib/types";

export function ChatBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 ${
          isUser
            ? "rounded-bl-sm bg-surface-2 text-foreground"
            : "rounded-br-sm bg-emerald-600 text-white"
        }`}
      >
        <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
        <div
          className={`mt-1 flex items-center gap-2 text-[10px] ${
            isUser ? "text-muted" : "text-emerald-100/80"
          }`}
        >
          <span>{formatTime(message.timestamp)}</span>
          {message.keyUsed && message.keyUsed !== "none" && (
            <span className="font-mono">· {message.keyUsed}</span>
          )}
        </div>
      </div>
    </div>
  );
}
