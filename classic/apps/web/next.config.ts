import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import type { webpack as WebpackTypes } from "next/dist/compiled/webpack/webpack";
import { withBotId } from "botid/next/config";
import { withContentCollections } from "@content-collections/next";

const webRootDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRootDirectory = resolve(webRootDirectory, "../..");
const localWasmEntry = resolve(
	workspaceRootDirectory,
	"rust/wasm/pkg/opencut_wasm.js",
);
const runtimeTarget =
	process.env.OPENCUT_RUNTIME_TARGET === "electron" ? "electron" : "browser";

const nextConfig: NextConfig = {
	distDir: process.env.OPENCUT_BUILD_DIR || ".next",
	typescript: { tsconfigPath: "tsconfig.build.json" },
	allowedDevOrigins: ["127.0.0.1"],
	compiler: {
		removeConsole: process.env.NODE_ENV === "production",
	},
	compress: runtimeTarget === "browser",
	poweredByHeader: false,
	reactStrictMode: true,
	productionBrowserSourceMaps:
		process.env.OPENCUT_BROWSER_SOURCE_MAPS?.toLowerCase() === "true",
	env: {
		NEXT_PUBLIC_OPENCUT_RUNTIME_TARGET: runtimeTarget,
	},
	experimental: {
		optimizePackageImports: [
			"@hugeicons/react",
			"@radix-ui/react-icons",
			"motion",
			"react-icons",
			"radix-ui",
		],
	},
	output: "standalone",
	// Runtime transcription caches are local, mutable user data. They must not
	// be copied into a production standalone bundle (the Whisper cache alone
	// can be several gigabytes and may exhaust the build disk).
	outputFileTracingExcludes: {
		"**/*": [".opencut-data/**/*"],
	},
	// Bun stores `file:` dependencies as copied packages. A WASM rebuild can
	// otherwise update the JS glue without replacing the installed binary,
	// leaving a bundler with an impossible wrapper/export-table combination.
	// Turbopack reads the direct local package path from tsconfig; webpack needs
	// the absolute alias below. Both resolve the generated glue and binary
	// together instead of the copied dependency.
	turbopack: {
		root: workspaceRootDirectory,
	},
	webpack: (config, { isServer, dev, webpack }) => {
		config.resolve.alias = {
			...config.resolve.alias,
			"opencut-wasm": localWasmEntry,
		};
		config.experiments = {
			...config.experiments,
			asyncWebAssembly: true,
		};
		if (isServer && !dev) {
			// Next emits node chunks under server/chunks, but its shared runtime
			// resolves async WASM relative to server/. Emit that runtime copy as a
			// tracked asset so both page collection and standalone packaging work.
			config.plugins.push({ apply(compiler: WebpackTypes.Compiler) {
				compiler.hooks.thisCompilation.tap("OpenCutServerWasm", (compilation: WebpackTypes.Compilation) => {
					compilation.hooks.processAssets.tap({ name: "OpenCutServerWasm", stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL }, () => {
						for (const asset of compilation.getAssets()) if (/^static\/wasm\/[^/]+\.wasm$/.test(asset.name)) compilation.emitAsset(`../${asset.name}`, asset.source);
					});
				});
			} });
		}
		return config;
	},
	images: {
		localPatterns: [{ pathname: "/**" }],
		remotePatterns: [
			{
				protocol: "https",
				hostname: "plus.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.marblecms.com",
			},
			{
				protocol: "https",
				hostname: "lh3.googleusercontent.com",
			},
			{
				protocol: "https",
				hostname: "avatars.githubusercontent.com",
			},
			{
				protocol: "https",
				hostname: "api.iconify.design",
			},
			{
				protocol: "https",
				hostname: "api.simplesvg.com",
			},
			{
				protocol: "https",
				hostname: "api.unisvg.com",
			},
			{
				protocol: "https",
				hostname: "cdn.brandfetch.io",
			},
		],
	},
};

export default withContentCollections(withBotId(nextConfig));
