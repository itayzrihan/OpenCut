import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { stageRepositoryAssetPaths } from "@/git/repository-assets";

export const runtime = "nodejs";

const MAX_FONT_BYTES = 25 * 1024 * 1024;
const FONT_MIME_TYPES = new Map([
	["ttf", "font/ttf"],
	["otf", "font/otf"],
	["woff", "font/woff"],
	["woff2", "font/woff2"],
]);

function sanitizeSegment({
	value,
}: {
	value: FormDataEntryValue | null;
}): string | null {
	if (typeof value !== "string") return null;
	const safe = value.replace(/[^a-zA-Z0-9_-]/g, "");
	return safe.length > 0 ? safe : null;
}

function getExtension({ fileName }: { fileName: string }): string {
	return fileName.split(".").pop()?.toLowerCase() ?? "";
}

async function pathExists({ target }: { target: string }): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

async function resolvePublicRoot(): Promise<{
	publicRoot: string;
	repositoryRoot: string;
}> {
	const cwd = process.cwd();
	const candidates = [
		{
			publicRoot: path.join(cwd, "public"),
			repositoryRoot: "public",
		},
		{
			publicRoot: path.join(cwd, "apps", "web", "public"),
			repositoryRoot: path.join("apps", "web", "public"),
		},
	];

	for (const candidate of candidates) {
		if (await pathExists({ target: candidate.publicRoot })) {
			return candidate;
		}
	}

	return candidates[0];
}

export async function POST(request: Request) {
	try {
		const formData = await request.formData();
		const projectId = sanitizeSegment({ value: formData.get("projectId") });
		const fontId = sanitizeSegment({ value: formData.get("fontId") });
		const file = formData.get("file");

		if (!projectId || !fontId || !(file instanceof File)) {
			return NextResponse.json(
				{ error: "Missing font upload data" },
				{ status: 400 },
			);
		}

		const extension = getExtension({ fileName: file.name });
		const mimeType = FONT_MIME_TYPES.get(extension);
		if (!mimeType) {
			return NextResponse.json(
				{ error: "Unsupported font type" },
				{ status: 400 },
			);
		}

		if (file.size > MAX_FONT_BYTES) {
			return NextResponse.json(
				{ error: "Font file is too large" },
				{ status: 413 },
			);
		}

		const { publicRoot, repositoryRoot } = await resolvePublicRoot();
		const projectFontsDir = path.join(publicRoot, "project-fonts", projectId);
		const storedFileName = `${fontId}.${extension}`;
		const storedPath = path.join(projectFontsDir, storedFileName);

		await mkdir(projectFontsDir, { recursive: true });
		await writeFile(storedPath, Buffer.from(await file.arrayBuffer()));
		await stageRepositoryAssetPaths({ paths: [storedPath] });

		const sourceUrl = `/project-fonts/${projectId}/${storedFileName}`;
		const repositoryPath = path.posix.join(
			...repositoryRoot.split(path.sep),
			"project-fonts",
			projectId,
			storedFileName,
		);

		return NextResponse.json({
			sourceUrl,
			repositoryPath,
			mimeType,
		});
	} catch (error) {
		console.error("Failed to copy project font:", error);
		return NextResponse.json({ error: "Failed to copy font" }, { status: 500 });
	}
}
