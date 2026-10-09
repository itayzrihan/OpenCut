// The server uses Node. Browser integration suites marked with
// @opencut-test-runner: node run the same TypeScript source in that runtime.
// This hook resolves the web app's aliases and extensionless local imports;
// TypeScript only removes types/JSX, without bundling or replacing dependencies.
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
registerHooks({
	resolve(specifier, context, nextResolve) {
		const target = specifier.startsWith("@/")
			? pathToFileURL(path.join(sourceRoot, specifier.slice(2))).href
			: specifier;
		try {
			return nextResolve(target, context);
		} catch (error) {
			if (
				!["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"].includes(
					error.code,
				) ||
				(!target.startsWith("file:") && !target.startsWith("."))
			)
				throw error;
			const url = new URL(target, context.parentURL);
			for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx", ".js"]) {
				const candidate = new URL(url.href + suffix);
				if (existsSync(candidate))
					return { url: candidate.href, shortCircuit: true };
			}
			throw error;
		}
	},
	load(url, context, nextLoad) {
		if (!/\.tsx?$/.test(url)) return nextLoad(url, context);
		const { outputText } = ts.transpileModule(
			readFileSync(new URL(url), "utf8"),
			{
				fileName: fileURLToPath(url),
				compilerOptions: {
					target: ts.ScriptTarget.ES2022,
					module: ts.ModuleKind.ESNext,
					jsx: ts.JsxEmit.ReactJSX,
				},
			},
		);
		return { format: "module", source: outputText, shortCircuit: true };
	},
});
