// Uploads media/app/*.png (except zz-* bug captures) to the EmDash media library once each,
// recording name → {id, url} in media/app/uploaded.json. Usage: node scripts/upload-media.mjs <site-url>
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const site = process.argv[2];
const dir = "media/app";
const manifest = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, "utf8"));
const outFile = `${dir}/uploaded.json`;
const uploaded = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : {};

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".png") && !f.startsWith("zz-")).sort()) {
	const name = file.replace(/\.png$/, "");
	if (uploaded[name]) continue;
	const alt = (manifest[name]?.caption ?? name).slice(0, 250);
	const out = execFileSync(process.execPath, ["node_modules/emdash/dist/cli/index.mjs", "media", "upload", `${dir}/${file}`, "--url", site, "--alt", alt, "--json"], { encoding: "utf8" });
	const json = JSON.parse(out.slice(out.indexOf("{")));
	uploaded[name] = { id: json.id, url: json.url, width: json.width, height: json.height };
	fs.writeFileSync(outFile, JSON.stringify(uploaded, null, 2));
	console.log(`${name} → ${json.url}`);
}
console.log(`done: ${Object.keys(uploaded).length} images`);
