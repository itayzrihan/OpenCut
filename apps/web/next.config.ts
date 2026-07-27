import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { withContentCollections } from "@content-collections/next";

const webRootDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRootDirectory = resolve(webRootDirectory, "../..");
const localWasmEntry = resolve(
	workspaceRootDirectory,
	"rust/wasm/pkg/opencut_wasm.js",
);

const nextConfig: NextConfig = {
	compiler: {
		removeConsole: process.env.NODE_ENV === "production",
	},
	reactStrictMode: true,
	productionBrowserSourceMaps: true,
	output: "standalone",
	// Bun stores `file:` dependencies as copied packages. A WASM rebuild can
	// otherwise update the JS glue without replacing the installed binary,
	// leaving a bundler with an impossible wrapper/export-table combination.
	// Turbopack reads the direct local package path from tsconfig; webpack needs
	// the absolute alias below. Both resolve the generated glue and binary
	// together instead of the copied dependency.
	turbopack: {
		root: workspaceRootDirectory,
	},
	webpack: (config) => {
		config.resolve.alias = {
			...config.resolve.alias,
			"opencut-wasm": localWasmEntry,
		};
		return config;
	},
	images: {
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
