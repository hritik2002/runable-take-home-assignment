import { db } from "./db/index.js";
import { sessions, messages } from "./db/schema.js";
import { eq, asc, desc } from "drizzle-orm";
import type { CoreMessage } from "./compaction.js";

export async function getOrCreateSession(sessionId?: string): Promise<string> {
  if (sessionId) {
    const existing = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (existing.length > 0) {
      return sessionId;
    }
  }
  
  const newSessionId = crypto.randomUUID();
  await db.insert(sessions).values({
    id: newSessionId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return newSessionId;
}

export async function saveMessage(
  sessionId: string,
  role: "user" | "assistant" | "system",
  content: string
): Promise<void> {
  // Get max sequence by finding the message with highest sequence
  const maxMessage = await db
    .select({ sequence: messages.sequence })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.sequence))
    .limit(1);
  
  const nextSequence = (maxMessage[0]?.sequence ?? -1) + 1;
  
  await db.insert(messages).values({
    id: crypto.randomUUID(),
    sessionId,
    role,
    content,
    createdAt: new Date(),
    sequence: nextSequence,
  });
  
  await db
    .update(sessions)
    .set({ updatedAt: new Date() })
    .where(eq(sessions.id, sessionId));
}

export async function loadMessages(sessionId: string): Promise<CoreMessage[]> {
  const dbMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.sequence));
  
  return dbMessages.map((msg) => ({
    role: msg.role as "user" | "assistant" | "system",
    content: msg.content,
  }));
}

export async function clearMessages(sessionId: string): Promise<void> {
  await db.delete(messages).where(eq(messages.sessionId, sessionId));
}

export async function saveCompactedMessages(sessionId: string, compactedMessages: CoreMessage[]): Promise<void> {
  await clearMessages(sessionId);
  
  for (let i = 0; i < compactedMessages.length; i++) {
    const msg = compactedMessages[i];
    await db.insert(messages).values({
      id: crypto.randomUUID(),
      sessionId,
      role: msg.role as "user" | "assistant" | "system",
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      createdAt: new Date(),
      sequence: i,
    });
  }
}
