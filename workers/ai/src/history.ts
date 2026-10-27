// Chat history in D1 (schema: migrations/0001_chat_history.sql). Every read
// and write is scoped to an `owner`, so a visitor or user only ever sees
// their own conversations.

import type { ChatTurn } from "./agent.ts";
import type { Visual } from "./tools.ts";

export const GUEST_RETENTION_DAYS = 30;
export const LIVE_RETENTION_DAYS = 180;
const MAX_TITLE = 80;
const MAX_LIST = 50;
const MAX_MESSAGE = 20_000;

export interface ConversationRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  visuals: Visual[];
  created_at: number;
}

const VISITOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** History owner for this request, or null when history can't be kept. */
export function ownerFor(session: { domain: string; userId?: number; user?: string } | null, visitorId: string | null): string | null {
  if (session) return `live:${session.domain}:${session.userId ?? session.user ?? "user"}`;
  if (visitorId && VISITOR_ID.test(visitorId)) return `guest:${visitorId.toLowerCase()}`;
  return null;
}

export function titleFrom(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_TITLE ? `${oneLine.slice(0, MAX_TITLE - 1)}…` : oneLine || "New chat";
}

export async function listConversations(db: D1Database, owner: string): Promise<ConversationRow[]> {
  const { results } = await db
    .prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE owner = ? ORDER BY updated_at DESC LIMIT ?")
    .bind(owner, MAX_LIST)
    .all<ConversationRow>();
  return results;
}

export async function getConversation(db: D1Database, owner: string, id: string): Promise<ConversationRow | null> {
  return db.prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE id = ? AND owner = ?").bind(id, owner).first<ConversationRow>();
}

export async function createConversation(db: D1Database, owner: string, firstMessage: string, now = Date.now()): Promise<ConversationRow> {
  const row = { id: crypto.randomUUID(), title: titleFrom(firstMessage), created_at: now, updated_at: now };
  await db.prepare("INSERT INTO conversations (id, owner, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(row.id, owner, row.title, now, now).run();
  return row;
}

export async function getMessages(db: D1Database, owner: string, id: string): Promise<StoredMessage[] | null> {
  if (!(await getConversation(db, owner, id))) return null;
  const { results } = await db
    .prepare("SELECT role, content, visuals, created_at FROM messages WHERE conversation_id = ? ORDER BY id")
    .bind(id)
    .all<{ role: "user" | "assistant"; content: string; visuals: string | null; created_at: number }>();
  return results.map((r) => ({ ...r, visuals: r.visuals ? (JSON.parse(r.visuals) as Visual[]) : [] }));
}

/** The last [limit] text turns, for the model's context. */
export async function recentTurns(db: D1Database, conversationId: string, limit = 12): Promise<ChatTurn[]> {
  const { results } = await db
    .prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?")
    .bind(conversationId, limit)
    .all<ChatTurn>();
  return results.reverse();
}

export async function addMessage(db: D1Database, conversationId: string, role: "user" | "assistant", content: string, visuals: Visual[] = [], now = Date.now()): Promise<void> {
  await db.batch([
    db
      .prepare("INSERT INTO messages (conversation_id, role, content, visuals, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(conversationId, role, content.slice(0, MAX_MESSAGE), visuals.length ? JSON.stringify(visuals) : null, now),
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(now, conversationId),
  ]);
}

export async function deleteConversation(db: D1Database, owner: string, id: string): Promise<boolean> {
  const conv = await getConversation(db, owner, id);
  if (!conv) return false;
  await db.batch([
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id),
    db.prepare("DELETE FROM conversations WHERE id = ? AND owner = ?").bind(id, owner),
  ]);
  return true;
}

/** Daily clean-up: guest chats after 30 days, signed-in chats after 180 days of inactivity. */
export async function purgeOld(db: D1Database, now = Date.now()): Promise<number> {
  const day = 86_400_000;
  const stale = `(owner LIKE 'guest:%' AND updated_at < ?1) OR (owner LIKE 'live:%' AND updated_at < ?2)`;
  const guestCutoff = now - GUEST_RETENTION_DAYS * day;
  const liveCutoff = now - LIVE_RETENTION_DAYS * day;
  const [, deleted] = await db.batch([
    db.prepare(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE ${stale})`).bind(guestCutoff, liveCutoff),
    db.prepare(`DELETE FROM conversations WHERE ${stale}`).bind(guestCutoff, liveCutoff),
  ]);
  return deleted.meta.changes ?? 0;
}
