// Pushes the Portable Text content of seed/seed.json to a running site for the
// given slugs (or every doc), through the EmDash CLI and its saved login.
//
//   node scripts/update-docs.mjs <site url> [slug ...]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, ...only] = process.argv.slice(2);
if (!url) throw new Error("Usage: node scripts/update-docs.mjs <site url> [slug ...]");
const seed = JSON.parse(readFileSync("seed/seed.json", "utf8"));
const docs = seed.content.docs.filter((d) => !only.length || only.includes(d.slug));
const dir = mkdtempSync(join(tmpdir(), "emdash-update-"));
const cli = (...args) => execFileSync("npx", ["emdash", ...args, "--url", url, "--json"], { encoding: "utf8", shell: true });

try {
	for (const doc of docs) {
		const current = JSON.parse(cli("content", "get", "docs", doc.slug, "--raw"));
		const file = join(dir, `${doc.slug}.json`);
		writeFileSync(file, JSON.stringify({ content: doc.data.content }));
		cli("content", "update", "docs", current.id, "--rev", current._rev, "--file", `"${file}"`);
		console.log(`updated ${doc.slug}`);
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
