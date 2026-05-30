import { formatTime } from "@/lib/format";
import type { Message } from "@/lib/types";

export function ChatBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`message-bubble ${isUser ? "message-user" : "message-assistant"}`}>
        <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
        <div className={`message-meta ${isUser ? "text-white/70" : "text-muted"}`}>
          <span>{formatTime(message.timestamp)}</span>
          {message.keyUsed && message.keyUsed !== "none" && (
            <span className="font-mono">· {message.keyUsed}</span>
          )}
        </div>
      </div>
    </div>
  );
}
