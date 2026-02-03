import Anthropic from "@anthropic-ai/sdk";
import { initDb } from "./db/index.js";
import { getOrCreateSession, saveMessage, loadMessages, saveCompactedMessages } from "./session.js";
import { ensureDockerContainer, execInContainer, checkContainerHealth } from "./docker.js";
import { shouldCompact, compactMessages } from "./compaction.js";
import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY environment variable is required");
  process.exit(1);
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Get session ID from command line or create new one
const sessionId = process.argv[2] || undefined;

const WORK_DIR = "/workspace";

// Tool definitions for Anthropic API
const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "readFile",
    description: "Read the contents of a file",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "The path to the file to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "writeFile",
    description: "Write content to a file",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "The path to the file to write" },
        content: { type: "string", description: "The content to write to the file" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "listDirectory",
    description: "List files and directories in a path. Use '.' for current directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "The directory path to list, use '.' for current directory" },
      },
      required: ["path"],
    },
  },
  {
    name: "executeCommand",
    description: "Execute a shell command in the Docker container",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The shell command to execute" },
      },
      required: ["command"],
    },
  },
];

// Tool execution functions
async function executeTool(
  toolName: string,
  toolInput: Record<string, any>,
  containerId: string
): Promise<string> {
  switch (toolName) {
    case "readFile": {
      try {
        let path = toolInput.path as string;
        if (path.startsWith("/")) path = path.slice(1);
        const fullPath = join(process.cwd(), path);
        const content = await readFile(fullPath, "utf-8");
        return JSON.stringify({ success: true, content });
      } catch (error: any) {
        return JSON.stringify({ success: false, error: error.message });
      }
    }
    case "writeFile": {
      try {
        let path = toolInput.path as string;
        const content = toolInput.content as string;
        if (path.startsWith("/")) path = path.slice(1);
        const fullPath = join(process.cwd(), path);
        const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
        if (dir && !existsSync(dir)) {
          await mkdir(dir, { recursive: true });
        }
        await writeFile(fullPath, content, "utf-8");
        return JSON.stringify({ success: true, message: `File written to ${path}` });
      } catch (error: any) {
        return JSON.stringify({ success: false, error: error.message });
      }
    }
    case "listDirectory": {
      try {
        let path = toolInput.path as string;
        if (path.startsWith("/")) path = path.slice(1);
        const fullPath = path === "." ? process.cwd() : join(process.cwd(), path);
        const entries = await readdir(fullPath);
        const results = await Promise.all(
          entries.map(async (entry) => {
            const entryPath = join(fullPath, entry);
            const stats = await stat(entryPath);
            return {
              name: entry,
              type: stats.isDirectory() ? "directory" : "file",
              size: stats.size,
            };
          })
        );
        return JSON.stringify({ success: true, entries: results });
      } catch (error: any) {
        return JSON.stringify({ success: false, error: error.message });
      }
    }
    case "executeCommand": {
      try {
        const command = toolInput.command as string;
        const result = await execInContainer(containerId, command);
        return JSON.stringify({
          success: true,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.stderr ? 1 : 0,
        });
      } catch (error: any) {
        if (error.message.includes("Container crashed")) {
          return JSON.stringify({
            success: false,
            error: "Container crashed. It will be recreated on the next command.",
            containerCrashed: true,
          });
        }
        return JSON.stringify({ success: false, error: error.message });
      }
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

type Message = Anthropic.MessageParam;

async function main() {
  console.log("🤖 Context-Compacting Coding Agent");
  console.log("===================================\n");

  // Initialize database
  initDb();
  console.log("✅ Database initialized\n");

  // Get or create session
  const currentSessionId = await getOrCreateSession(sessionId);
  if (sessionId && sessionId === currentSessionId) {
    console.log(`📂 Resuming session: ${currentSessionId}\n`);
  } else {
    console.log(`📂 New session: ${currentSessionId}\n`);
  }

  // Ensure Docker container is running
  let containerId: string;
  try {
    containerId = await ensureDockerContainer(currentSessionId);
    console.log(`🐳 Docker container ready: ${containerId.substring(0, 12)}\n`);
  } catch (error: any) {
    console.error("❌ Failed to set up Docker container:", error.message);
    console.error("   Make sure Docker is running and accessible.");
    process.exit(1);
  }

  // System prompt
  const systemPrompt = `You are a helpful coding assistant. You can read and write files, execute commands in a Docker container, and help with programming tasks.

The Docker container is running and ready. You can execute commands using the executeCommand tool.
The workspace directory in the container is ${WORK_DIR}.

When working on tasks:
1. Break down complex tasks into smaller steps
2. Test your code as you go
3. Provide clear explanations of what you're doing
4. Handle errors gracefully`;

  // Load existing messages
  const savedMessages = await loadMessages(currentSessionId);
  let messages: Message[] = savedMessages.filter(m => m.role !== "system").map(m => ({
    role: m.role as "user" | "assistant",
    content: m.content as string,
  }));

  // Main agent loop
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, resolve);
    });
  };

  console.log("💬 Agent ready! Type your message (or 'exit' to quit):\n");

  while (true) {
    const userInput = await question("You: ");
    
    if (userInput.toLowerCase() === "exit") {
      console.log("\n👋 Goodbye!");
      break;
    }

    if (!userInput.trim()) {
      continue;
    }

    // Save user message
    await saveMessage(currentSessionId, "user", userInput);
    messages.push({ role: "user", content: userInput });

    // Check if we need to compact
    const coreMessages = messages.map(m => ({ 
      role: m.role, 
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) 
    }));
    if (shouldCompact(coreMessages)) {
      const compacted = await compactMessages(coreMessages);
      await saveCompactedMessages(currentSessionId, compacted);
      messages = compacted.filter(m => m.role !== "system").map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content as string,
      }));
    }

    // Ensure container is still healthy
    if (!(await checkContainerHealth(containerId))) {
      console.log("⚠️  Container crashed, recreating...");
      containerId = await ensureDockerContainer(currentSessionId);
      console.log(`🐳 Container recreated: ${containerId.substring(0, 12)}\n`);
    }

    try {
      let currentMessages = [...messages];
      let finalResponse = "";
      
      // Agentic loop - keep running until no more tool calls
      while (true) {
        const response = await client.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 8096,
          system: systemPrompt,
          tools: toolDefinitions,
          messages: currentMessages,
        });

        // Process the response
        let hasToolUse = false;
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        
        for (const block of response.content) {
          if (block.type === "text") {
            process.stdout.write(block.text);
            finalResponse += block.text;
          } else if (block.type === "tool_use") {
            hasToolUse = true;
            console.log(`\n🔧 Using tool: ${block.name}`);
            
            const result = await executeTool(block.name, block.input as Record<string, any>, containerId);
            console.log(`   Result: ${result.substring(0, 100)}${result.length > 100 ? "..." : ""}`);
            
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result,
            });

            // Check if container crashed
            const parsed = JSON.parse(result);
            if (parsed.containerCrashed) {
              containerId = await ensureDockerContainer(currentSessionId);
              console.log(`\n🐳 Container recreated: ${containerId.substring(0, 12)}`);
            }
          }
        }

        // If there were tool uses, add them and results to messages and continue
        if (hasToolUse) {
          currentMessages.push({ role: "assistant", content: response.content });
          currentMessages.push({ role: "user", content: toolResults });
        }

        // If stop reason is end_turn or no more tool calls, we're done
        if (response.stop_reason === "end_turn" || !hasToolUse) {
          break;
        }
      }

      // Save final response
      if (finalResponse.trim()) {
        await saveMessage(currentSessionId, "assistant", finalResponse);
        messages.push({ role: "assistant", content: finalResponse });
      }

      console.log("\n");
    } catch (error: any) {
      console.error("\n❌ Error:", error.message);
      const errorMessage = `Error: ${error.message}`;
      await saveMessage(currentSessionId, "assistant", errorMessage);
      messages.push({ role: "assistant", content: errorMessage });
    }
  }

  rl.close();
}

main().catch(console.error);
