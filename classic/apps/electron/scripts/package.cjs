"use strict";

const { join } = require("node:path");
const { build, Platform } = require("electron-builder");
const { build: baseConfiguration } = require("../package.json");

const unpacked = process.argv.includes("--dir");
const targets = Platform.current().createTarget(unpacked ? "dir" : null);
const appDirectory = join(__dirname, "..", "app");
const buildDirectory = process.env.OPENCUT_BUILD_DIR || ".next";
if (!/^\.next(?:-[a-zA-Z0-9_-]+)?$/.test(buildDirectory)) {
	throw new Error("OPENCUT_BUILD_DIR must be .next or a .next- prefixed directory name");
}

const configuration = {
	...baseConfiguration,
	electronVersion: "43.4.0",
	directories: {
		...baseConfiguration.directories,
		app: undefined,
		output: "../dist",
	},
	icon: "../../web/public/icons/ms-icon-310x310.png",
	extraResources: baseConfiguration.extraResources.map((resource) => ({
		...resource,
		from: `../${resource.from.replace(/\.next(?=\/)/g, buildDirectory)}`,
		to: resource.to.replace(/\.next(?=\/)/g, buildDirectory),
	})),
	win: {
		...baseConfiguration.win,
		// Keep local/CI builds independent of Windows Developer Mode. A signed
		// release pipeline can opt back in with OPENCUT_WINDOWS_SIGNING=true.
		signAndEditExecutable:
			process.env.OPENCUT_WINDOWS_SIGNING?.toLowerCase() === "true",
	},
};

build({
	projectDir: appDirectory,
	targets,
	config: configuration,
}).catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
