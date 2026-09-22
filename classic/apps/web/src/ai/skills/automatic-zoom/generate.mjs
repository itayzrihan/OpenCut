import { readFile, writeFile } from "node:fs/promises";
const input = await readFile(new URL("./SKILL.md", import.meta.url), "utf8");
const content = input.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
const output = `// Generated from SKILL.md by generate.mjs; do not edit.\nexport const AUTOMATIC_ZOOM_SKILL = ${JSON.stringify(content)};\n`;
const path = new URL("./runtime.generated.ts", import.meta.url);
if (process.argv.includes("--check")) {
 if (await readFile(path,"utf8") !== output) throw new Error("Automatic Zoom skill projection is stale");
} else await writeFile(path,output);
