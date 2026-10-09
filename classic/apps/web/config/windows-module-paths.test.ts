import { expect, test } from "bun:test";
import { canonicalWorkspacePath } from "./windows-module-paths";

test("Windows workspace junction spellings share one module identity without conflating files or packages", () => {
	const workspaceRoot = "C:\\DEV\\OpenCut\\classic";
	const normalize = (path: string, platform: NodeJS.Platform = "win32") =>
		canonicalWorkspacePath({ path, workspaceRoot, platform });
	expect(
		normalize(
			"C:\\Dev\\OpenCut\\classic\\node_modules\\.bun\\clsx@2\\index.mjs",
		),
	).toBe("C:\\DEV\\OpenCut\\classic\\node_modules\\.bun\\clsx@2\\index.mjs");
	expect(
		normalize("c:/dev/opencut/classic/rust/editor-runtime-wasm/pkg/Runtime.js"),
	).toBe(
		"C:\\DEV\\OpenCut\\classic\\rust\\editor-runtime-wasm\\pkg\\Runtime.js",
	);
	expect(normalize("C:\\Dev\\OpenCut\\classic-old\\index.js")).toBe(
		"C:\\Dev\\OpenCut\\classic-old\\index.js",
	);
	expect(normalize("D:\\other\\node_modules\\clsx\\index.mjs")).toBe(
		"D:\\other\\node_modules\\clsx\\index.mjs",
	);
	expect(normalize("virtual:module")).toBe("virtual:module");
	expect(normalize("C:\\Dev\\OpenCut\\classic\\Runtime.js", "linux")).toBe(
		"C:\\Dev\\OpenCut\\classic\\Runtime.js",
	);
	expect(normalize("C:\\Dev\\OpenCut\\classic\\runtime.js")).not.toBe(
		normalize("C:\\Dev\\OpenCut\\classic\\Runtime.js"),
	);
});
