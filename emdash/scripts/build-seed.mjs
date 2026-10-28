// Builds seed/seed.json from the current CloudPOS docs (Fumadocs MDX under
// cloudpos-docs/content/docs): one `docs` entry per page, in sidebar order,
// with the body converted to Portable Text. Markdown tables become EmDash
// table blocks (the markdown converter alone would flatten them to text).
//
//   node scripts/build-seed.mjs [path/to/content/docs]

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { markdownToPortableText } from "emdash/client";

const root = process.argv[2] ?? "../eposmob/cloudpos-docs/content/docs";

/** Sidebar sections, in order, from the docs' meta.json files. `code` is a word found nowhere
 * else in the docs, so typing it in the admin search lists just that section. */
const SECTIONS = [
	{ dir: "pos-app", label: "POS App", code: "posapp" },
	{ dir: "api", label: "API Reference", code: "apiref" },
	{ dir: "admin-panel", label: "Admin Panel", code: "adminpanel" },
	{ dir: "ecom/user-guide", label: "Online Store · User Guide", code: "storeguide" },
	{ dir: "ecom/developer", label: "Online Store · Developer Docs", code: "storedev" },
];

/** App screenshots uploaded by scripts/upload-media.mjs; docs embed them as ![alt](media:NAME). */
const media = existsSync("media/app/uploaded.json") ? JSON.parse(readFileSync("media/app/uploaded.json", "utf8")) : {};

/** Points media:NAME images at the uploaded file and links the media item. */
function resolveImage(block) {
	const name = block.asset?.url?.startsWith("media:") && block.asset.url.slice(6);
	if (!name) return block;
	const item = media[name];
	if (!item) throw new Error(`Screenshot "${name}" is not uploaded; run scripts/upload-media.mjs`);
	return { ...block, asset: { _ref: item.id, url: item.url }, ...(item.width ? { width: item.width, height: item.height } : {}) };
}

let keyCount = 0;
const key = () => `k${(keyCount++).toString(36)}`;

function frontmatter(source) {
	const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) return { body: source };
	const field = (name) => m[1].match(new RegExp(`^${name}:\\s*["']?(.+?)["']?\\s*$`, "m"))?.[1];
	return { body: source.slice(m[0].length), title: field("title"), description: field("description") };
}

/**
 * MDX → plain markdown: drop MDX imports/exports, JSX tags and comments, keep
 * their text. Code is left untouched: fenced blocks and `inline code` often
 * show JSX or import lines on purpose (the developer docs do).
 */
function toMarkdown(body) {
	const clean = (prose) =>
		prose
			.split(/(`[^`\n]+`)/)
			.map((part, i) => (i % 2 ? part : part.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/<\/?[A-Z][\w.]*[^>]*>/g, "")))
			.join("")
			.replace(/^(import|export)\s.*$/gm, "");
	let firstHeadingRemoved = false;
	return body
		.replace(/\r/g, "")
		.split(/(^```[\s\S]*?^```[ \t]*$)/m)
		.map((part, i) => {
			if (i % 2) return part; // fenced code block
			let prose = clean(part);
			// The page title is rendered from the title field.
			if (!firstHeadingRemoved && /^#\s+.+$/m.test(prose)) {
				prose = prose.replace(/^#\s+.+$/m, "");
				firstHeadingRemoved = true;
			}
			return prose;
		})
		.join("")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const isRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isSeparator = (line) => /^\s*\|?\s*:?-{2,}/.test(line);
const cellsOf = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

/** Inline markdown in a table cell → spans (bold, italic, code, links). */
function cell(text, isHeader) {
	const [block] = markdownToPortableText(text || " ");
	return {
		_type: "tableCell",
		_key: key(),
		content: block?.children ?? [{ _type: "span", _key: key(), text: "", marks: [] }],
		...(block?.markDefs?.length ? { markDefs: block.markDefs } : {}),
		...(isHeader ? { isHeader: true } : {}),
	};
}

function table(lines) {
	const rows = [cellsOf(lines[0]), ...lines.slice(2).map(cellsOf)];
	return {
		_type: "table",
		_key: key(),
		hasHeaderRow: true,
		rows: rows.map((row, i) => ({ _type: "tableRow", _key: key(), cells: row.map((c) => cell(c, i === 0)) })),
	};
}

/** Markdown with tables → Portable Text blocks, in document order. */
export function portableText(markdown) {
	const lines = markdown.split("\n");
	const blocks = [];
	let buffer = [];
	const flush = () => {
		const text = buffer.join("\n").trim();
		if (text) blocks.push(...markdownToPortableText(text).map((b) => (b._type === "image" ? resolveImage(b) : b)));
		buffer = [];
	};
	for (let i = 0; i < lines.length; i++) {
		if (isRow(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
			flush();
			const rows = [lines[i], lines[i + 1]];
			i += 2;
			while (i < lines.length && isRow(lines[i])) rows.push(lines[i++]);
			i--;
			blocks.push(table(rows));
		} else {
			buffer.push(lines[i]);
		}
	}
	flush();
	return blocks;
}

async function sectionPages(section) {
	const meta = JSON.parse(await readFile(join(root, section.dir, "meta.json"), "utf8"));
	const files = (await readdir(join(root, section.dir))).filter((f) => f.endsWith(".mdx"));
	const order = (name) => {
		const i = meta.pages.indexOf(name);
		return i < 0 ? 999 : i;
	};
	return files.map((f) => f.replace(/\.mdx$/, "")).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
}

const entries = [];
for (const [s, section] of SECTIONS.entries()) {
	for (const [i, page] of (await sectionPages(section)).entries()) {
		const source = await readFile(join(root, section.dir, `${page}.mdx`), "utf8");
		const { body, title, description } = frontmatter(source);
		const path = page === "index" ? section.dir : `${section.dir}/${page}`;
		entries.push({
			id: `doc-${path.replace(/\//g, "-")}`,
			// Entry slugs are flat; "--" stands in for "/" (see src/utils/docs.ts).
			slug: path.replace(/\//g, "--"),
			status: "published",
			data: {
				title: title || page,
				description: description || "",
				section: section.label,
				search_code: section.code,
				order: s * 100 + i,
				content: portableText(toMarkdown(body)),
			},
		});
	}
}

const seed = {
	$schema: "https://emdashcms.com/seed.schema.json",
	version: "1",
	meta: { name: "CloudPOS Docs", description: "CloudPOS user and developer documentation", author: "CloudPOS" },
	settings: { title: "CloudPOS Docs", tagline: "Guides for the CloudPOS app, admin panel and online store" },
	collections: [
		{
			slug: "docs",
			label: "Docs",
			labelSingular: "Doc",
			supports: ["drafts", "revisions", "search", "seo"],
			admin: { listColumns: ["section", "search_code"] },
			fields: [
				{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
				{ slug: "description", label: "Description", type: "text", searchable: true },
				{
					slug: "section",
					label: "Section",
					type: "select",
					required: true,
					searchable: true,
					validation: { options: [...new Set(entries.map((e) => e.data.section))] },
				},
				{ slug: "order", label: "Order in sidebar", type: "integer" },
				{ slug: "content", label: "Content", type: "portableText", searchable: true },
				{
					slug: "search_code",
					label: "Search code",
					type: "select",
					searchable: true,
					validation: { options: SECTIONS.map((s) => s.code) },
				},
			],
		},
	],
	menus: [
		{
			name: "primary",
			label: "Primary Navigation",
			items: [
				{ type: "custom", label: "POS App", url: "/docs/pos-app" },
				{ type: "custom", label: "API Reference", url: "/docs/api" },
				{ type: "custom", label: "Admin Panel", url: "/docs/admin-panel" },
				{ type: "custom", label: "Online Store", url: "/docs/ecom/user-guide" },
			],
		},
	],
	content: { docs: entries },
};

await writeFile("seed/seed.json", `${JSON.stringify(seed, null, "\t")}\n`);
const tables = entries.reduce((n, e) => n + e.data.content.filter((b) => b._type === "table").length, 0);
console.log(`${entries.length} pages, ${tables} tables → seed/seed.json`);
