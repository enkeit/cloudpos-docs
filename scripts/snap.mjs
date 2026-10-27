// Copies the newest Marionette screenshot from this Claude session's tool-results into media/app/<name>.png.
// Usage: node scripts/snap.mjs <name> ["caption"]
import fs from "node:fs";
import path from "node:path";
const [name, caption = ""] = process.argv.slice(2);
const dir = "C:/Users/gokul/.claude/projects/D--Projects-ENKE-eposmob/a1bb43a4-32fe-4438-87c4-458167ac7d40/tool-results";
const newest = fs.readdirSync(dir).filter((f) => f.startsWith("mcp-marionette-blob") && f.endsWith(".png"))
	.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
const out = path.resolve("media/app", `${name}.png`);
fs.copyFileSync(path.join(dir, newest.f), out);
const manifest = "media/app/manifest.json";
const m = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : {};
m[name] = { caption, from: newest.f, at: new Date().toISOString() };
fs.writeFileSync(manifest, JSON.stringify(m, null, 2));
console.log(`${name}.png ← ${newest.f}`);
