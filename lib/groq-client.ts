import { groqManager } from "./groq-manager";
import { SYSTEM_PROMPT } from "./system-prompt";
import type { Role } from "./types";

/**
 * Generate an AI response with automatic multi-key failover.
 * Falls back to the default SYSTEM_PROMPT when none is supplied.
 */
// Slightly creative but consistent for chat; deterministic for memory tasks.
const CHAT_TEMPERATURE = Number(process.env.GROQ_CHAT_TEMPERATURE ?? 0.6);

export async function generateAIResponse(
  messages: { role: Role; content: string }[],
  systemPrompt?: string,
): Promise<{ text: string; keyUsed: string; tokensUsed: number }> {
  return groqManager.generate(messages, systemPrompt ?? SYSTEM_PROMPT, undefined, CHAT_TEMPERATURE);
}

/**
 * Generation for memory tasks (fact extraction, summarization). Defaults to the
 * capable 70B model for reliable extraction (token budget is ample with 5 keys)
 * and temperature 0 for deterministic, structured output.
 */
export async function generateUtility(
  prompt: string,
  systemPrompt: string,
  model: string = process.env.GROQ_MEMORY_MODEL ?? "llama-3.3-70b-versatile",
): Promise<string> {
  const result = await groqManager.generate(
    [{ role: "user", content: prompt }],
    systemPrompt,
    model,
    0,
  );
  return result.text;
}
