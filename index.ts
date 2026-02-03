import Anthropic from "@anthropic-ai/sdk";
import { initDb } from "./db/index.js";
import { getOrCreateSession, saveMessage, loadMessages, saveCompactedMessages } from "./session.js";
import { ensureDockerContainer, execInContainer, checkContainerHealth } from "./docker.js";
import { shouldCompact, isContextOverflowError, compactMessages, type CoreMessage } from "./compaction.js";
import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const sessionId = process.argv[2];

const SYSTEM_PROMPT = `You are a helpful coding assistant with access to a Docker container.
Available tools: readFile, writeFile, listDirectory, executeCommand.
Be concise. Test your code. Handle errors gracefully.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "readFile",
    description: "Read file contents",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "writeFile",
    description: "Write content to file",
    input_schema: {
      type: "object" as const,
      properties: { 
        path: { type: "string" }, 
        content: { type: "string" } 
      },
      required: ["path", "content"],
    },
  },
  {
    name: "listDirectory",
    description: "List directory contents",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "executeCommand",
    description: "Execute shell command in Docker container",
    input_schema: {
      type: "object" as const,
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

async function executeTool(name: string, input: any, containerId: string): Promise<string> {
  try {
    switch (name) {
      case "readFile": {
        const path = input.path.startsWith("/") ? input.path.slice(1) : input.path;
        const content = await readFile(join(process.cwd(), path), "utf-8");
        return JSON.stringify({ success: true, content });
      }
      case "writeFile": {
        const path = input.path.startsWith("/") ? input.path.slice(1) : input.path;
        const fullPath = join(process.cwd(), path);
        const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
        if (dir && !existsSync(dir)) await mkdir(dir, { recursive: true });
        await writeFile(fullPath, input.content, "utf-8");
        return JSON.stringify({ success: true });
      }
      case "listDirectory": {
        const path = input.path.startsWith("/") ? input.path.slice(1) : input.path;
        const fullPath = path === "." ? process.cwd() : join(process.cwd(), path);
        const entries = await readdir(fullPath);
        const results = await Promise.all(entries.map(async name => {
          const s = await stat(join(fullPath, name));
          return { name, type: s.isDirectory() ? "dir" : "file", size: s.size };
        }));
        return JSON.stringify({ success: true, entries: results });
      }
      case "executeCommand": {
        const result = await execInContainer(containerId, input.command);
        return JSON.stringify({ success: true, ...result });
      }
      default:
        return JSON.stringify({ error: "Unknown tool" });
    }
  } catch (e: any) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

async function chat(
  messages: Anthropic.MessageParam[],
  containerId: string
): Promise<{ response: string; inputTokens: number; outputTokens: number }> {
  let currentMsgs = [...messages];
  let fullResponse = "";
  let totalInput = 0;
  let totalOutput = 0;

  while (true) {
    const res = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: currentMsgs,
    });

    totalInput = res.usage.input_tokens; // Last call's input = full context
    totalOutput += res.usage.output_tokens;

    let hasToolUse = false;
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of res.content) {
      if (block.type === "text") {
        process.stdout.write(block.text);
        fullResponse += block.text;
      } else if (block.type === "tool_use") {
        hasToolUse = true;
        console.log(`\n🔧 ${block.name}`);
        const result = await executeTool(block.name, block.input, containerId);
        console.log(`   → ${result.slice(0, 80)}${result.length > 80 ? "..." : ""}`);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
    }

    if (!hasToolUse || res.stop_reason === "end_turn") break;
    
    currentMsgs.push({ role: "assistant", content: res.content });
    currentMsgs.push({ role: "user", content: toolResults });
  }

  return { response: fullResponse, inputTokens: totalInput, outputTokens: totalOutput };
}

async function main() {
  console.log("🤖 Context-Compacting Coding Agent\n");

  initDb();
  const currentSessionId = await getOrCreateSession(sessionId);
  console.log(`📂 Session: ${currentSessionId}`);

  let containerId: string;
  try {
    containerId = await ensureDockerContainer(currentSessionId);
    console.log(`🐳 Docker: ${containerId.slice(0, 12)}\n`);
  } catch (e: any) {
    console.error("❌ Docker failed:", e.message);
    process.exit(1);
  }

  // Load saved messages
  const saved = await loadMessages(currentSessionId);
  let messages: Anthropic.MessageParam[] = saved
    .filter(m => m.role !== "system")
    .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

  let lastInputTokens = 0;

  const rl = (await import("readline")).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q: string) => new Promise<string>(r => rl.question(q, r));

  console.log("💬 Ready! ('exit' to quit)\n");

  while (true) {
    const input = await ask("You: ");
    if (input.toLowerCase() === "exit") break;
    if (!input.trim()) continue;

    await saveMessage(currentSessionId, "user", input);
    messages.push({ role: "user", content: input });

    // Check container health
    if (!(await checkContainerHealth(containerId))) {
      console.log("⚠️ Recreating container...");
      containerId = await ensureDockerContainer(currentSessionId);
    }

    // Retry loop with compaction on overflow
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { response, inputTokens, outputTokens } = await chat(messages, containerId);
        lastInputTokens = inputTokens;

        if (response.trim()) {
          await saveMessage(currentSessionId, "assistant", response);
          messages.push({ role: "assistant", content: response });
        }

        console.log(`\n📊 ${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out\n`);

        // Proactive compaction for next turn
        if (shouldCompact(lastInputTokens)) {
          console.log("⚠️ Approaching limit, compacting...");
          const core: CoreMessage[] = messages.map(m => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          }));
          const compacted = await compactMessages(core);
          await saveCompactedMessages(currentSessionId, compacted);
          messages = compacted.filter(m => m.role !== "system").map(m => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }));
        }
        break; // Success, exit retry loop

      } catch (error: any) {
        if (isContextOverflowError(error) && attempt === 0) {
          console.log("\n🚨 Context overflow! Compacting and retrying...");
          const core: CoreMessage[] = messages.map(m => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          }));
          const compacted = await compactMessages(core, 4); // Keep fewer messages
          await saveCompactedMessages(currentSessionId, compacted);
          messages = compacted.filter(m => m.role !== "system").map(m => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }));
        } else {
          console.error("\n❌", error.message);
          messages.push({ role: "assistant", content: `Error: ${error.message}` });
          break;
        }
      }
    }
  }

  rl.close();
  console.log("\n👋 Bye!");
}

main().catch(console.error);
