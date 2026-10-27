// Chunks every page under cloudpos-docs/content/docs and sends the full set to
// the worker, which embeds them and replaces the Vectorize index contents.
//
//   AI_URL=https://cloudpos-ai.<subdomain>.workers.dev ADMIN_TOKEN=... npm run index-docs
//   npm run index-docs -- --dry-run      (print chunk stats only)

import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { chunkMdx } from "../src/docs.ts";

const root = fileURLToPath(new URL("../../../content/docs", import.meta.url));
const dryRun = process.argv.includes("--dry-run");

// App screenshots live in the docs CMS media library; pages embed them as
// ![alt](media:NAME). docs-media.json maps NAME → its site-relative file URL.
const mediaFile = fileURLToPath(new URL("../docs-media.json", import.meta.url));
const media = existsSync(mediaFile) ? JSON.parse(readFileSync(mediaFile, "utf8")) : {};
const resolveMedia = (source) =>
  source.replace(/\]\(media:([\w-]+)\)/g, (match, name) => (media[name] ? `](${media[name]})` : match));

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.mdx?$/.test(entry.name)) yield full;
  }
}

const chunks = [];
for await (const file of walk(root)) {
  chunks.push(...chunkMdx(relative(root, file), resolveMedia(await readFile(file, "utf8"))));
}
const pages = new Set(chunks.map((c) => c.url)).size;
console.log(`${chunks.length} chunks from ${pages} pages`);

if (dryRun) {
  for (const c of chunks) console.log(`${c.id.padEnd(48)} ${String(c.text.length).padStart(5)}  ${c.heading}`);
  process.exit(0);
}

const base = process.env.AI_URL ?? "http://localhost:8787";
const token = process.env.ADMIN_TOKEN;
if (!token) {
  console.error("ADMIN_TOKEN is required.");
  process.exit(1);
}
const res = await fetch(`${base.replace(/\/$/, "")}/api/admin/reindex`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ chunks }),
});
const text = await res.text();
console.log(res.status, text);
if (!res.ok) process.exit(1);
