// Files signed-in users attach to chat messages: images (seen by the vision
// model) and PDFs (converted to text with Workers AI toMarkdown). Bytes live
// in R2 under uploads/<id>; the D1 `attachments` row (schema in
// migrations/0002_attachments.sql) records the owner, so every read is scoped
// to the user who uploaded the file. Both are deleted after RETENTION_DAYS.

import type { Attachments } from "./agent.ts";

export const UPLOAD_LIMITS = {
  /** Images are shrunk in the browser first; this only stops oversized raw uploads. */
  imageBytes: 4_000_000,
  pdfBytes: 10_000_000,
  pdfPages: 30,
  imagesPerMessage: 4,
  pdfsPerMessage: 2,
  /** Attachments per user per day (fair use; images are the costly part). */
  perDay: 40,
  retentionDays: 30,
};

export type AttachmentKind = "image" | "pdf";

/** What the client and the chat history see about an attachment. */
export interface AttachmentRef {
  id: string;
  kind: AttachmentKind;
  name: string;
  size: number;
  pages?: number;
}

export class UploadError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAttachmentId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

/** The real file type from its first bytes; the browser's claim is not trusted. */
export function sniffType(bytes: Uint8Array): { kind: AttachmentKind; mime: string } | null {
  const at = (i: number, ...values: number[]) => values.every((v, j) => bytes[i + j] === v);
  if (at(0, 0xff, 0xd8, 0xff)) return { kind: "image", mime: "image/jpeg" };
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: "image", mime: "image/png" };
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { kind: "image", mime: "image/webp" };
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return { kind: "pdf", mime: "application/pdf" };
  return null;
}

/** A display name without paths or control characters. */
export function safeFileName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f<>"]/g, "").trim().slice(0, 120);
  return clean || fallback;
}

/**
 * Page count from the PDF's page objects. Returns null when they are hidden
 * in compressed object streams, so the limit is then left to the text size.
 */
export function countPdfPages(bytes: Uint8Array): number | null {
  const text = new TextDecoder("latin1").decode(bytes);
  const pages = text.match(/\/Type\s*\/Page(?![s\w])/g)?.length ?? 0;
  return pages || null;
}

export function toDataUri(bytes: Uint8Array, mime: string): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}

interface Row {
  id: string;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  pages: number | null;
  text: string | null;
}

const refOf = (r: Row): AttachmentRef => ({ id: r.id, kind: r.kind, name: r.name, size: r.size, ...(r.pages ? { pages: r.pages } : {}) });

async function pdfText(ai: Ai, name: string, bytes: Uint8Array): Promise<string> {
  const result = (await ai.toMarkdown(
    { name: "upload.pdf", blob: new Blob([bytes], { type: "application/pdf" }) },
    { conversionOptions: { pdf: { metadata: false } } } as never,
  )) as unknown as {
    format?: string;
    data?: string;
    error?: string;
  };
  if (result.format === "error" || typeof result.data !== "string") {
    throw new UploadError(`Couldn't read "${name}". Please check the file isn't password-protected.`);
  }
  return result.data.trim();
}

/** Validates and stores one uploaded file for [owner]. */
export async function saveUpload(env: Env, owner: string, file: File, now = Date.now()): Promise<AttachmentRef> {
  if (file.size > UPLOAD_LIMITS.pdfBytes) throw new UploadError("That file is too large. The limit is 10 MB.", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffType(bytes);
  if (!type) throw new UploadError("Only JPG, PNG and WebP images and PDF files can be attached.", 415);
  if (type.kind === "image" && bytes.length > UPLOAD_LIMITS.imageBytes) throw new UploadError("That image is too large. The limit is 4 MB.", 413);

  const id = crypto.randomUUID();
  const name = safeFileName(file.name, type.kind === "pdf" ? "document.pdf" : "image");
  let pages: number | null = null;
  let text: string | null = null;
  if (type.kind === "pdf") {
    pages = countPdfPages(bytes);
    if (pages && pages > UPLOAD_LIMITS.pdfPages) throw new UploadError(`"${name}" has ${pages} pages. PDFs can have up to ${UPLOAD_LIMITS.pdfPages} pages.`, 413);
    text = await pdfText(env.AI, name, bytes);
    if (text.replace(/\s+/g, "").length < 20) {
      throw new UploadError(`"${name}" has no readable text (it may be a scan). Please attach photos of the pages instead.`, 422);
    }
  }

  await env.UPLOADS.put(`uploads/${id}`, bytes, { httpMetadata: { contentType: type.mime } });
  await env.DB.prepare("INSERT INTO attachments (id, owner, kind, name, mime, size, pages, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, owner, type.kind, name, type.mime, bytes.length, pages, text, now)
    .run();
  return refOf({ id, kind: type.kind, name, mime: type.mime, size: bytes.length, pages, text });
}

/** The stored file, only for its owner. */
export async function readUpload(env: Env, owner: string, id: string): Promise<{ body: ReadableStream; mime: string; name: string } | null> {
  if (!isAttachmentId(id)) return null;
  const row = await env.DB.prepare("SELECT mime, name FROM attachments WHERE id = ? AND owner = ?").bind(id, owner).first<{ mime: string; name: string }>();
  if (!row) return null;
  const object = await env.UPLOADS.get(`uploads/${id}`);
  return object ? { body: object.body, mime: row.mime, name: row.name } : null;
}

/**
 * The attachments of one message, checked against the per-message limits:
 * refs for history and the client, images as data URIs and PDF text for the model.
 */
export async function loadAttachments(env: Env, owner: string, ids: string[]): Promise<{ refs: AttachmentRef[]; files: Attachments }> {
  const unique = [...new Set(ids)];
  if (!unique.every(isAttachmentId)) throw new UploadError("Unknown attachment.");
  if (!unique.length) return { refs: [], files: { images: [], documents: [] } };
  const { results } = await env.DB.prepare(
    `SELECT id, kind, name, mime, size, pages, text FROM attachments WHERE owner = ? AND id IN (${unique.map(() => "?").join(", ")})`,
  )
    .bind(owner, ...unique)
    .all<Row>();
  if (results.length !== unique.length) throw new UploadError("An attachment has expired or was removed. Please attach it again.", 404);
  const rows = unique.map((id) => results.find((r) => r.id === id)!);
  const images = rows.filter((r) => r.kind === "image");
  const pdfs = rows.filter((r) => r.kind === "pdf");
  if (images.length > UPLOAD_LIMITS.imagesPerMessage) throw new UploadError(`You can attach up to ${UPLOAD_LIMITS.imagesPerMessage} images per message.`);
  if (pdfs.length > UPLOAD_LIMITS.pdfsPerMessage) throw new UploadError(`You can attach up to ${UPLOAD_LIMITS.pdfsPerMessage} PDFs per message.`);

  const imageData = await Promise.all(
    images.map(async (r) => {
      const object = await env.UPLOADS.get(`uploads/${r.id}`);
      if (!object) throw new UploadError("An attachment has expired or was removed. Please attach it again.", 404);
      return toDataUri(new Uint8Array(await object.arrayBuffer()), r.mime);
    }),
  );
  return {
    refs: rows.map(refOf),
    files: { images: imageData, documents: pdfs.map((r) => ({ name: r.name, text: r.text ?? "" })) },
  };
}

/** Daily clean-up of attachments older than the retention period. */
export async function purgeUploads(env: Env, now = Date.now()): Promise<number> {
  const cutoff = now - UPLOAD_LIMITS.retentionDays * 86_400_000;
  let removed = 0;
  for (;;) {
    const { results } = await env.DB.prepare("SELECT id FROM attachments WHERE created_at < ? LIMIT 500").bind(cutoff).all<{ id: string }>();
    if (!results.length) return removed;
    const ids = results.map((r) => r.id);
    await env.UPLOADS.delete(ids.map((id) => `uploads/${id}`));
    await env.DB.prepare(`DELETE FROM attachments WHERE id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).run();
    removed += ids.length;
  }
}
