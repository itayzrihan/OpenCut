import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function getGitRoot(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["rev-parse", "--show-toplevel"],
			{ cwd: process.cwd(), windowsHide: true },
		);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

function toGitRelativePath({
	gitRoot,
	filePath,
}: {
	gitRoot: string;
	filePath: string;
}): string | null {
	const relativePath = path.relative(gitRoot, filePath);
	if (
		!relativePath ||
		relativePath.startsWith("..") ||
		path.isAbsolute(relativePath)
	) {
		return null;
	}

	return relativePath.split(path.sep).join(path.posix.sep);
}

export async function stageRepositoryAssetPaths({
	paths,
}: {
	paths: string[];
}): Promise<void> {
	const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
	if (uniquePaths.length === 0) return;

	const gitRoot = await getGitRoot();
	if (!gitRoot) return;

	const gitRelativePaths = uniquePaths.flatMap((filePath) => {
		const resolvedPath = path.resolve(filePath);
		const gitRelativePath = toGitRelativePath({
			gitRoot,
			filePath: resolvedPath,
		});
		return gitRelativePath ? [gitRelativePath] : [];
	});
	if (gitRelativePaths.length === 0) return;

	try {
		await execFileAsync("git", ["add", "--", ...gitRelativePaths], {
			cwd: gitRoot,
			windowsHide: true,
		});
	} catch (error) {
		console.warn("Failed to stage repository asset files:", error);
	}
}
