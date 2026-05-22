import type { ToolSet } from "ai";
import { groqManager } from "./groq-manager";
import { SYSTEM_PROMPT } from "./system-prompt";
import type { Role } from "./types";

// Slightly creative but consistent for chat; lower when tools are active so the
// model reliably emits structured tool calls instead of free-form text.
const CHAT_TEMPERATURE = Number(process.env.GROQ_CHAT_TEMPERATURE ?? 0.6);
const TOOL_TEMPERATURE = Number(process.env.GROQ_TOOL_TEMPERATURE ?? 0.2);

/**
 * Generate an AI response with automatic multi-key failover. Optionally pass a
 * toolset to let the model take actions (e.g. Trello) via multi-step tool calls.
 */
export async function generateAIResponse(
  messages: { role: Role; content: string }[],
  systemPrompt?: string,
  tools?: ToolSet,
): Promise<{ text: string; keyUsed: string; tokensUsed: number }> {
  return groqManager.generate(messages, {
    systemPrompt: systemPrompt ?? SYSTEM_PROMPT,
    temperature: tools ? TOOL_TEMPERATURE : CHAT_TEMPERATURE,
    tools,
    maxSteps: 4,
  });
}

/**
 * Generation for memory tasks (fact extraction, summarization). Uses the cheap
 * fast 8B model by default — these run every turn and are simple, so we keep the
 * 70B daily quota for actual chat. Temperature 0 for deterministic output.
 */
export async function generateUtility(
  prompt: string,
  systemPrompt: string,
  model: string = process.env.GROQ_MEMORY_MODEL ?? "llama-3.1-8b-instant",
): Promise<string> {
  const result = await groqManager.generate([{ role: "user", content: prompt }], {
    systemPrompt,
    model,
    temperature: 0,
  });
  return result.text;
}
