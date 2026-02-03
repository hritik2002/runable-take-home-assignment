import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY environment variable is required");
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Anthropic Claude context window is 200k tokens
// We'll compact when we approach ~150k tokens (roughly 75% of capacity)
const CONTEXT_LIMIT_TOKENS = 150000;
const ESTIMATED_TOKENS_PER_CHAR = 0.25; // Rough estimate: 4 chars per token

export interface CoreMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

function estimateTokens(messages: CoreMessage[]): number {
  const totalChars = messages.reduce((sum, msg) => {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    return sum + content.length;
  }, 0);
  return Math.ceil(totalChars * ESTIMATED_TOKENS_PER_CHAR);
}

export function shouldCompact(messages: CoreMessage[]): boolean {
  return estimateTokens(messages) > CONTEXT_LIMIT_TOKENS;
}

export async function compactMessages(messages: CoreMessage[]): Promise<CoreMessage[]> {
  console.log("🔄 Compacting conversation history...");
  
  // Keep the first user message and system messages
  const systemMessages = messages.filter((m) => m.role === "system");
  const firstUserMessage = messages.find((m) => m.role === "user");
  const recentMessages = messages.slice(-10); // Keep last 10 messages for context
  
  // Create a summary prompt
  const messagesToSummarize = messages.filter(
    (m) => m.role !== "system" && m !== firstUserMessage && !recentMessages.includes(m)
  );
  
  if (messagesToSummarize.length === 0) {
    return messages; // Nothing to compact
  }
  
  const conversationText = messagesToSummarize
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
    .join("\n\n");
  
  const summaryPrompt = `Please provide a concise summary of the following conversation history, preserving all important decisions, code changes, and context that would be needed to continue the work:

${conversationText}

Provide a summary that captures:
1. The main goals and objectives
2. Key decisions made
3. Important code changes or implementations
4. Any errors encountered and how they were resolved
5. Current state of the project

Format the summary as a clear, structured narrative.`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [{ role: "user", content: summaryPrompt }],
    });
    
    const summary = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    
    // Reconstruct messages: system messages, summary, then recent messages
    const compacted: CoreMessage[] = [
      ...systemMessages,
      { role: "assistant" as const, content: `[Previous conversation summarized]: ${summary}` },
      ...(firstUserMessage ? [firstUserMessage] : []),
      ...recentMessages,
    ];
    
    console.log(`✅ Compaction complete. Reduced ${messages.length} messages to ${compacted.length} messages.`);
    return compacted;
  } catch (error) {
    console.error("❌ Compaction failed, keeping original messages:", error);
    return messages; // Fallback to original if compaction fails
  }
}
