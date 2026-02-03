import { exec } from "child_process";
import { promisify } from "util";
import { db } from "./db/index.js";
import { dockerContainers } from "./db/schema.js";
import { eq } from "drizzle-orm";

const execAsync = promisify(exec);

const CONTAINER_NAME = "coding-agent-container";
const CONTAINER_IMAGE = "node:20-alpine";

export async function ensureDockerContainer(sessionId: string): Promise<string> {
  try {
    // Check if container exists and is running
    try {
      const { stdout } = await execAsync(`docker ps -a --filter name=${CONTAINER_NAME} --format "{{.ID}} {{.Status}}"`);
      if (stdout.trim()) {
        const [containerId, ...statusParts] = stdout.trim().split(" ");
        const status = statusParts.join(" ");
        
        if (status.includes("Up")) {
          // Container is running
          await saveContainerInfo(sessionId, containerId);
          return containerId;
        } else {
          // Container exists but is stopped, start it
          await execAsync(`docker start ${containerId}`);
          await saveContainerInfo(sessionId, containerId);
          return containerId;
        }
      }
    } catch (error) {
      // Container doesn't exist, create it
    }

    // Create new container
    const { stdout: containerId } = await execAsync(
      `docker run -d --name ${CONTAINER_NAME} ${CONTAINER_IMAGE} tail -f /dev/null`
    );
    const trimmedId = containerId.trim();
    await saveContainerInfo(sessionId, trimmedId);
    return trimmedId;
  } catch (error: any) {
    // If container creation fails, try to recreate
    try {
      await execAsync(`docker rm -f ${CONTAINER_NAME} 2>/dev/null || true`);
      const { stdout: containerId } = await execAsync(
        `docker run -d --name ${CONTAINER_NAME} ${CONTAINER_IMAGE} tail -f /dev/null`
      );
      const trimmedId = containerId.trim();
      await saveContainerInfo(sessionId, trimmedId);
      return trimmedId;
    } catch (recreateError) {
      throw new Error(`Failed to create Docker container: ${recreateError}`);
    }
  }
}

async function saveContainerInfo(sessionId: string, containerId: string) {
  const existing = await db.select().from(dockerContainers).where(eq(dockerContainers.sessionId, sessionId)).limit(1);
  
  if (existing.length === 0) {
    await db.insert(dockerContainers).values({
      id: crypto.randomUUID(),
      containerId,
      sessionId,
      createdAt: new Date(),
    });
  }
}

export async function execInContainer(containerId: string, command: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(`docker exec ${containerId} sh -c ${JSON.stringify(command)}`);
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: any) {
    // Check if container is still running
    try {
      await execAsync(`docker ps --filter id=${containerId} --format "{{.ID}}"`);
    } catch {
      throw new Error("Container crashed or was removed");
    }
    return { stdout: "", stderr: error.message };
  }
}

export async function checkContainerHealth(containerId: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`docker ps --filter id=${containerId} --format "{{.ID}}"`);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
