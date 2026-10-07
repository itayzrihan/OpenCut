import { realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, join } from "node:path";
import { homedir } from "node:os";
import { accountDataRoot, accountsRoot, canImportLegacy } from "./server";

function within({ root, path }: { root: string; path: string }) {
	const rel = relative(root, path);
	return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
}
async function canonical(path: string) {
	return realpath(path).catch((error) => {
		if (error.code === "ENOENT") return resolve(path);
		throw error;
	});
}
export async function assertAccountMediaSource(source: string) {
	const path = await realpath(source);
	if (
		!/\.(mp4|mov|mkv|webm|avi|m4v|mp3|wav|aac|flac|ogg|m4a|png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(
			extname(path),
		)
	)
		throw new Error("Only supported media files can be registered");
	const privateRoot = await canonical(accountsRoot()),
		ownRoot = await canonical(accountDataRoot());
	if (
		within({ root: privateRoot, path: path }) &&
		!within({ root: ownRoot, path: path })
	)
		throw new Error(
			"This media belongs to another account or to private host storage",
		);
	const legacyRoots = [
		join(homedir(), "Movies", "OpenCut Legacy Assets"),
		process.env.POCUT_PROJECTS_DIR ||
			join(homedir(), "Movies", "PoCut Projects"),
		process.env.OPENCUT_LEGACY_PUBLIC_DIR ||
			join(process.cwd(), "../../../.local/legacy-public"),
	];
	for (const root of legacyRoots)
		if (
			within({ root: await canonical(root), path: path }) &&
			!(await canImportLegacy())
		)
			throw new Error("The legacy media belongs to the installation owner");
	return path;
}
