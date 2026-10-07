import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { createWasmManifest } from "./write-wasm-manifests.mjs";

for (const [directory, name] of [
	["wasm", "opencut_wasm"],
	["editor-runtime-wasm", "opencut_editor_runtime_wasm"],
]) {
	test(`${directory}: repeat builds retain generated entrypoints and side effects`, async () => {
		const wrapper = JSON.parse(
			await readFile(
				new URL(`../rust/${directory}/package.json`, import.meta.url),
				"utf8",
			),
		);
		const manifest = createWasmManifest(wrapper);
		assert.equal(manifest.name, wrapper.name);
		assert.equal(manifest.version, wrapper.version);
		assert.equal(manifest.main, `./${name}.js`);
		assert.equal(manifest.types, `./${name}.d.ts`);
		assert.equal(manifest.exports["."].import, manifest.main);
		assert.deepEqual(manifest.sideEffects, [`./${name}.js`, "./snippets/*"]);
		assert.ok(manifest.files.includes(`${name}_bg.wasm`));
		assert.deepEqual(createWasmManifest(wrapper, manifest), manifest);
		assert.deepEqual(
			createWasmManifest(wrapper, { "runtime-dependency": "1.0.0" })
				.dependencies,
			{ "runtime-dependency": "1.0.0" },
		);
	});
}

test("conflicting dependency versions and out-of-package entrypoints fail explicitly", () => {
	const wrapper = {
		name: "test",
		version: "1.0.0",
		main: "./pkg/test.js",
		types: "./pkg/test.d.ts",
		dependencies: { library: "1.0.0" },
	};
	assert.throws(
		() => createWasmManifest(wrapper, { library: "2.0.0" }),
		/Conflicting/,
	);
	assert.throws(
		() => createWasmManifest({ ...wrapper, main: "./pkg/../other.js" }),
		/inside/,
	);
});
