import { getEmDashCollection } from "emdash";

/** Entry slugs are flat, so "--" stands in for "/" (pos-app--billing ↔ pos-app/billing). */
export const slugFromPath = (path: string) => path.replace(/\/+$/, "").replace(/\//g, "--");
export const pathFromSlug = (slug: string) => slug.replace(/--/g, "/");
export const docHref = (slug: string) => `/docs/${pathFromSlug(slug)}`;

export interface NavItem {
	slug: string;
	title: string;
	href: string;
}

export interface NavSection {
	label: string;
	items: NavItem[];
}

/** Every published doc, grouped by section in sidebar order. */
export async function loadNav() {
	const { entries, cacheHint } = await getEmDashCollection("docs", { limit: 500 });
	const sorted = [...entries].sort((a, b) => (a.data.order ?? 9999) - (b.data.order ?? 9999) || a.data.title.localeCompare(b.data.title));
	const sections: NavSection[] = [];
	for (const entry of sorted) {
		const label = entry.data.section || "Other";
		let section = sections.find((s) => s.label === label);
		if (!section) sections.push((section = { label, items: [] }));
		section.items.push({ slug: entry.id, title: entry.data.title, href: docHref(entry.id) });
	}
	return { sections, cacheHint };
}
