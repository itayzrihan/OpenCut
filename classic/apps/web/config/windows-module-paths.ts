import { win32 } from "node:path";

export interface WorkspacePathResolver {
	hooks: {
		result: {
			tap: (
				name: string,
				callback: (result: {
					path?: string | false;
					descriptionFilePath?: string;
					descriptionFileRoot?: string;
				}) => void,
			) => void;
		};
	};
}

/** Windows junction targets may retain an older spelling of the workspace root.
 * Webpack uses case-sensitive module identities even on a case-insensitive disk.
 * Only canonicalize that known root; retain package/version and filename casing.
 */
export function canonicalWorkspacePath({
	path,
	workspaceRoot,
	platform = process.platform,
}: {
	path: string;
	workspaceRoot: string;
	platform?: NodeJS.Platform;
}): string {
	if (platform !== "win32" || !win32.isAbsolute(path)) return path;
	const root = win32.normalize(workspaceRoot).replace(/[\\/]+$/, "");
	const candidate = win32.normalize(path);
	if (candidate.toLowerCase() === root.toLowerCase()) return root;
	return candidate.toLowerCase().startsWith(`${root.toLowerCase()}\\`)
		? root + candidate.slice(root.length)
		: path;
}
