// Pushes seed/seed.json docs (title, description, section, order, content) to a
// running site for the given slugs (or every doc), through the EmDash CLI and
// its saved login. Docs the site doesn't have yet are created and published.
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
const cli = (...args) =>
	execFileSync(process.execPath, ["node_modules/emdash/dist/cli/index.mjs", ...args, "--url", url, "--json"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
/** The live entry for a slug, or null when the site has none (other errors are retried, then thrown). */
const existing = (slug) => {
	for (let attempt = 1; ; attempt++) {
		try {
			return JSON.parse(cli("content", "get", "docs", slug, "--raw"));
		} catch (error) {
			if (/not found/i.test(String(error.stderr ?? error.message))) return null;
			if (attempt === 3) throw error;
		}
	}
};

try {
	for (const doc of docs) {
		const current = existing(doc.slug);
		const file = join(dir, `${doc.slug}.json`);
		writeFileSync(file, JSON.stringify(doc.data));
		if (current) {
			cli("content", "update", "docs", current.id, "--rev", current._rev, "--file", file);
			console.log(`updated ${doc.slug}`);
		} else {
			cli("content", "create", "docs", "--slug", doc.slug, "--file", file);
			console.log(`created ${doc.slug}`);
		}
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
