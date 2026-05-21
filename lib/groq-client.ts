import { groqManager } from "./groq-manager";
import { SYSTEM_PROMPT } from "./system-prompt";
import type { Role } from "./types";

/**
 * Generate an AI response with automatic multi-key failover.
 * Falls back to the default SYSTEM_PROMPT when none is supplied.
 */
export async function generateAIResponse(
  messages: { role: Role; content: string }[],
  systemPrompt?: string,
): Promise<{ text: string; keyUsed: string; tokensUsed: number }> {
  return groqManager.generate(messages, systemPrompt ?? SYSTEM_PROMPT);
}
