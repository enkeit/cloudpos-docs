// Builds seed/seed.json from the current CloudPOS docs (Fumadocs MDX under
// cloudpos-docs/content/docs): one `docs` entry per page, in sidebar order,
// with the body converted to Portable Text. Markdown tables become EmDash
// table blocks (the markdown converter alone would flatten them to text).
//
//   node scripts/build-seed.mjs [path/to/content/docs]

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { markdownToPortableText } from "emdash/client";

const root = process.argv[2] ?? "../eposmob/cloudpos-docs/content/docs";

/** Sidebar sections, in order, from the docs' meta.json files. */
const SECTIONS = [
	{ dir: "pos-app", label: "POS App" },
	{ dir: "admin-panel", label: "Admin Panel" },
	{ dir: "ecom/user-guide", label: "Online Store · User Guide" },
	{ dir: "ecom/developer", label: "Online Store · Developer Docs" },
];

let keyCount = 0;
const key = () => `k${(keyCount++).toString(36)}`;

function frontmatter(source) {
	const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) return { body: source };
	const field = (name) => m[1].match(new RegExp(`^${name}:\\s*["']?(.+?)["']?\\s*$`, "m"))?.[1];
	return { body: source.slice(m[0].length), title: field("title"), description: field("description") };
}

/** MDX → plain markdown: drop imports/exports, JSX tags and comments, keep their text. */
function toMarkdown(body) {
	return body
		.replace(/\r/g, "")
		.replace(/^(import|export)\s.*$/gm, "")
		.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
		.replace(/<\/?[A-Z][\w.]*[^>]*>/g, "")
		.replace(/^#\s+.+$/m, "") // the page title is rendered from the title field
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
		if (text) blocks.push(...markdownToPortableText(text));
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
			fields: [
				{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
				{ slug: "description", label: "Description", type: "text", searchable: true },
				{ slug: "section", label: "Section", type: "string", required: true },
				{ slug: "order", label: "Order in sidebar", type: "integer" },
				{ slug: "content", label: "Content", type: "portableText", searchable: true },
			],
		},
	],
	menus: [
		{
			name: "primary",
			label: "Primary Navigation",
			items: [
				{ type: "custom", label: "POS App", url: "/docs/pos-app" },
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
