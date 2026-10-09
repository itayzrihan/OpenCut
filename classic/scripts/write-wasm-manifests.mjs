import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

// wasm-pack 0.15 treats an existing pkg/package.json as a string-only map
// of wasm-bindgen dependencies, so a second build fails on its own files array.
// Build with --no-pack and derive the local package from our checked-in wrapper.
// https://github.com/wasm-bindgen/wasm-pack/blob/v0.15.0/src/manifest/mod.rs
export function createWasmManifest(wrapper, generated = {}) {
	const rebase = (value) => {
		if (
			typeof value !== "string" ||
			!value.startsWith("./pkg/") ||
			value.includes("..", 2)
		)
			throw new Error(
				"WASM wrapper entries must reference files inside ./pkg/",
			);
		return `./${value.slice("./pkg/".length)}`;
	};
	const rebaseExports = (value) => {
		if (typeof value === "string") return rebase(value);
		if (value === null) return null;
		if (typeof value !== "object" || Array.isArray(value))
			throw new Error("Unsupported WASM wrapper exports");
		return Object.fromEntries(
			Object.entries(value).map(([key, nested]) => [
				key,
				rebaseExports(nested),
			]),
		);
	};
	if (typeof wrapper.name !== "string" || typeof wrapper.version !== "string")
		throw new Error("WASM wrapper name and version are required");
	const main = rebase(wrapper.main);
	const types = rebase(wrapper.types);
	if (!main.endsWith(".js") || !types.endsWith(".d.ts"))
		throw new Error(
			"WASM wrapper must expose JavaScript and TypeScript entrypoints",
		);
	const stem = main.slice(2, -".js".length);
	const metadata = Object.fromEntries(
		[
			"name",
			"version",
			"description",
			"license",
			"repository",
			"homepage",
			"author",
			"keywords",
		]
			.filter((key) => wrapper[key] !== undefined)
			.map((key) => [key, wrapper[key]]),
	);
	// wasm-bindgen may write a flat dependency map; an earlier local build has
	// a complete manifest. Neither form should lose external package bindings.
	const bindings =
		generated.name === wrapper.name && typeof generated.main === "string"
			? (generated.dependencies ?? {})
			: generated;
	const dependencies = { ...(wrapper.dependencies ?? {}) };
	for (const [name, version] of Object.entries(bindings)) {
		if (typeof version !== "string")
			throw new Error(`Invalid generated WASM dependency: ${name}`);
		if (dependencies[name] !== undefined && dependencies[name] !== version)
			throw new Error(`Conflicting WASM dependency version: ${name}`);
		dependencies[name] = version;
	}
	return {
		...metadata,
		type: "module",
		files: [
			`${stem}_bg.wasm`,
			main.slice(2),
			`${stem}_bg.js`,
			types.slice(2),
			`${stem}_bg.wasm.d.ts`,
			"snippets",
		],
		main,
		types,
		...(wrapper.exports && { exports: rebaseExports(wrapper.exports) }),
		sideEffects: Array.isArray(wrapper.sideEffects)
			? wrapper.sideEffects.map(rebase)
			: (wrapper.sideEffects ?? true),
		...(Object.keys(dependencies).length > 0 && { dependencies }),
	};
}

async function writeManifest(directory) {
	const wrapperUrl = new URL(
		`../rust/${directory}/package.json`,
		import.meta.url,
	);
	const generatedUrl = new URL(
		`../rust/${directory}/pkg/package.json`,
		import.meta.url,
	);
	const wrapper = JSON.parse(await readFile(wrapperUrl, "utf8"));
	let generated = {};
	try {
		generated = JSON.parse(await readFile(generatedUrl, "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const manifest = createWasmManifest(wrapper, generated);
	await writeFile(generatedUrl, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`Wrote local ${manifest.name} manifest`);
}

if (
	process.argv[1] &&
	pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
	for (const directory of ["wasm", "editor-runtime-wasm"])
		await writeManifest(directory);
}
