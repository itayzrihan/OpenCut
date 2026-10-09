/** Host asset storage only. Timeline references remain canonical libraryAssetIds. */
import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { accountsRoot } from "@/accounts/server";
import type { SharedAudioAsset, SharedLibraryManifest } from "./types";

export function globalLibraryRoot() {
	return join(accountsRoot(), "global", "shared-library");
}

export async function readGlobalAudio(): Promise<SharedAudioAsset[]> {
	try {
		const manifest = JSON.parse(
			await readFile(join(globalLibraryRoot(), "manifest.json"), "utf8"),
		) as { audioAssets: SharedAudioAsset[] };
		if (!Array.isArray(manifest.audioAssets))
			throw new Error("Invalid global audio manifest");
		return manifest.audioAssets.map((asset) => ({
			...asset,
			visibility: "global",
		}));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw error;
	}
}

export async function withGlobalAudio(
	manifest: SharedLibraryManifest,
): Promise<SharedLibraryManifest> {
	const global = await readGlobalAudio();
	const ids = new Set(global.map((asset) => asset.id));
	return {
		...manifest,
		audioAssets: [
			...global,
			...manifest.audioAssets.filter((asset) => !ids.has(asset.id)),
		],
	};
}

/** Only explicitly published audio is shared, never arbitrary account files. */
export async function globalAudioFile(parts: string[]): Promise<string | null> {
	if (
		parts.length !== 4 ||
		parts[0] !== "shared-library" ||
		parts[1] !== "audio" ||
		!["music", "sfx"].includes(parts[2]) ||
		!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(parts[3])
	)
		return null;
	const assets = await readGlobalAudio();
	if (
		!assets.some(
			(asset) => asset.folder === parts[2] && asset.fileName === parts[3],
		)
	)
		return null;
	const root = globalLibraryRoot();
	try {
		const file = await realpath(join(root, ...parts.slice(1)));
		const inside = relative(await realpath(root), file);
		if (
			inside.startsWith("..") ||
			isAbsolute(inside) ||
			!(await stat(file)).isFile()
		)
			return null;
		return file;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
}
