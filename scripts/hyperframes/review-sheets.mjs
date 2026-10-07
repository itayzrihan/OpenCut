// Lossless evidence remains untouched. Contact sheets preserve portrait and
// landscape aspect ratios, and show three times rather than a cropped midpoint.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const sharp = createRequire(path.join(root, "classic/apps/web/package.json"))("sharp");
const catalog = JSON.parse(await readFile(path.join(root, "resources/hyperframes/catalog.json"), "utf8"));
const evidence = path.join(root, ".local/hyperframes-examples-batch", catalog.upstreamCommit);
const report = JSON.parse(await readFile(path.join(evidence, "report.json"), "utf8"));
const output = path.join(root, ".local/hyperframes-review");
await mkdir(output, { recursive: true });
const entries = [];
for (let start = 0; start < report.results.length; start += 6) {
  const items = report.results.slice(start, start + 6), layers = [];
  for (const [row, item] of items.entries()) {
    const metadata = catalog.items.find((candidate) => candidate.id === item.id);
    for (const [column, frame] of item.frames.slice(0, 3).entries()) {
      const image = await sharp(await readFile(path.join(evidence, item.id, frame.file)))
        .flatten({ background: "#66717d" }).resize(480, 270, { fit: "contain", background: "#66717d" }).png().toBuffer();
      layers.push({ input: image, left: column * 480, top: row * 296 + 26 });
    }
    layers.push({ input: Buffer.from(`<svg width="1440" height="26"><rect width="1440" height="26" fill="#111"/><text x="8" y="18" fill="white" font-size="14" font-family="Arial">${start + row + 1}. ${item.id} | ${item.kind} | ${item.durationSeconds}s | 15%, 50%, 85%</text></svg>`), left: 0, top: row * 296 });
    entries.push({ ...item, title: metadata.title, description: metadata.description, tags: metadata.tags });
  }
  await sharp({ create: { width: 1440, height: items.length * 296, channels: 3, background: "#111" } }).composite(layers).png().toFile(path.join(output, `review-${Math.floor(start / 6) + 1}.png`));
}
await writeFile(path.join(output, "review-entries.json"), JSON.stringify(entries, null, 2));
console.log(JSON.stringify({ entries: entries.length, sheets: Math.ceil(entries.length / 6), output }));
