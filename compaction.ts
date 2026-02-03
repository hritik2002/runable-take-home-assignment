import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// Compact when approaching 75% of 200k context window
export const COMPACT_THRESHOLD = 150_000;

export interface CoreMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Check if we should compact based on token usage
 */
export function shouldCompact(inputTokens: number): boolean {
  return inputTokens > COMPACT_THRESHOLD;
}

/**
 * Check if error is due to context overflow
 */
export function isContextOverflowError(error: any): boolean {
  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("context") || msg.includes("token") || msg.includes("too long");
}

/**
 * Compact messages by summarizing old conversation history
 * Keeps: system messages, summary of old messages, last N messages
 */
export async function compactMessages(
  messages: CoreMessage[], 
  keepLast: number = 6
): Promise<CoreMessage[]> {
  console.log("🔄 Compacting conversation history...");

  const systemMsgs = messages.filter(m => m.role === "system");
  const nonSystemMsgs = messages.filter(m => m.role !== "system");
  
  // Keep last N messages
  const recentMsgs = nonSystemMsgs.slice(-keepLast);
  const oldMsgs = nonSystemMsgs.slice(0, -keepLast);

  if (oldMsgs.length === 0) {
    console.log("   Nothing to compact.");
    return messages;
  }

  // Summarize old messages
  const oldText = oldMsgs
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: `Summarize this conversation concisely, keeping key decisions, code changes, and context:\n\n${oldText}`
      }],
    });

    const summary = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text)
      .join("");

    const result: CoreMessage[] = [
      ...systemMsgs,
      { role: "assistant", content: `[Summary of ${oldMsgs.length} previous messages]\n${summary}` },
      ...recentMsgs,
    ];

    console.log(`✅ Compacted: ${messages.length} → ${result.length} messages`);
    return result;
  } catch (error) {
    console.error("❌ Compaction failed:", error);
    // Fallback: just keep recent messages
    return [...systemMsgs, ...recentMsgs];
  }
}
