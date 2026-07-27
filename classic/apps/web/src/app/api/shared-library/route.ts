import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { stageRepositoryAssetPaths } from "@/git/repository-assets";
import type {
	GeneratedBackgroundPreset,
	GeneratedEffectPreset,
	SharedAssetCategory,
	SharedAudioAsset,
	SharedAudioFolder,
	SharedCaptionPreset,
	SharedLibraryManifest,
	SharedStickerAsset,
} from "@/shared-library/types";

export const runtime = "nodejs";

const MANIFEST_VERSION = 1;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_STICKER_BYTES = 25 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set([
	"aac",
	"aif",
	"aiff",
	"flac",
	"m4a",
	"mp3",
	"ogg",
	"opus",
	"wav",
	"webm",
]);
const STICKER_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "svg", "webp"]);

type ManifestPatch =
	| {
			action: "createCategory";
			category: SharedAssetCategory;
	  }
	| {
			action: "addAssetToCategory";
			categoryId: string;
			assetId: string;
	  }
	| {
			action: "removeAssetFromCategory";
			categoryId: string;
			assetId: string;
	  }
	| {
			action: "saveGeneratedBackground";
			preset: GeneratedBackgroundPreset;
	  }
	| {
			action: "saveGeneratedEffect";
			preset: GeneratedEffectPreset;
	  }
	| {
			action: "saveCaptionPreset";
			preset: SharedCaptionPreset;
	  };

function emptyManifest(): SharedLibraryManifest {
	return {
		version: MANIFEST_VERSION,
		audioAssets: [],
		stickerAssets: [],
		categories: [],
		generatedBackgrounds: [],
		generatedEffects: [],
		captionPresets: [],
		updatedAt: new Date().toISOString(),
	};
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

function toRepositoryPath({ parts }: { parts: string[] }): string {
	return path.posix.join(...parts.flatMap((part) => part.split(path.sep)));
}

async function getSharedLibraryPaths(): Promise<{
	publicRoot: string;
	repositoryRoot: string;
	libraryRoot: string;
	manifestPath: string;
}> {
	const { publicRoot, repositoryRoot } = await resolvePublicRoot();
	const libraryRoot = path.join(publicRoot, "shared-library");
	return {
		publicRoot,
		repositoryRoot,
		libraryRoot,
		manifestPath: path.join(libraryRoot, "manifest.json"),
	};
}

async function readManifest(): Promise<SharedLibraryManifest> {
	const { manifestPath } = await getSharedLibraryPaths();
	try {
		const raw = await readFile(manifestPath, "utf8");
		const parsed = JSON.parse(raw) as Partial<SharedLibraryManifest>;
		return {
			...emptyManifest(),
			...parsed,
			version: MANIFEST_VERSION,
			audioAssets: Array.isArray(parsed.audioAssets) ? parsed.audioAssets : [],
			stickerAssets: Array.isArray(parsed.stickerAssets)
				? parsed.stickerAssets
				: [],
			categories: Array.isArray(parsed.categories) ? parsed.categories : [],
			generatedBackgrounds: Array.isArray(parsed.generatedBackgrounds)
				? parsed.generatedBackgrounds
				: [],
			generatedEffects: Array.isArray(parsed.generatedEffects)
				? parsed.generatedEffects
				: [],
			captionPresets: Array.isArray(parsed.captionPresets)
				? parsed.captionPresets
				: [],
		};
	} catch {
		return emptyManifest();
	}
}

async function writeManifest({
	manifest,
}: {
	manifest: SharedLibraryManifest;
}): Promise<void> {
	const { libraryRoot, manifestPath } = await getSharedLibraryPaths();
	await mkdir(libraryRoot, { recursive: true });
	await writeFile(
		manifestPath,
		`${JSON.stringify(
			{
				...manifest,
				version: MANIFEST_VERSION,
				updatedAt: new Date().toISOString(),
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

function sanitizeId({ value }: { value: unknown }): string | null {
	if (typeof value !== "string") return null;
	const safe = value.replace(/[^a-zA-Z0-9_-]/g, "");
	return safe.length > 0 ? safe : null;
}

function getExtension({ fileName }: { fileName: string }): string {
	return fileName.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
}

function isAudioFolder(value: unknown): value is SharedAudioFolder {
	return value === "sfx" || value === "music";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMetadataArray({
	formData,
}: {
	formData: FormData;
}): Record<string, unknown>[] | null {
	const raw = formData.get("metadata");
	if (typeof raw !== "string") return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) && parsed.every(isObject)
			? (parsed as Record<string, unknown>[])
			: null;
	} catch {
		return null;
	}
}

function readString({
	value,
	fallback,
}: {
	value: unknown;
	fallback: string;
}): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readOptionalNumber({ value }: { value: unknown }): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}

function upsertById<T extends { id: string }>({
	items,
	item,
}: {
	items: T[];
	item: T;
}): T[] {
	return [item, ...items.filter((existing) => existing.id !== item.id)];
}

function parsePatch(body: unknown): ManifestPatch | null {
	if (!isObject(body) || typeof body.action !== "string") {
		return null;
	}
	switch (body.action) {
		case "createCategory":
			return isObject(body.category)
				? {
						action: body.action,
						category: body.category as unknown as SharedAssetCategory,
					}
				: null;
		case "addAssetToCategory":
		case "removeAssetFromCategory":
			return typeof body.categoryId === "string" &&
				typeof body.assetId === "string"
				? {
						action: body.action,
						categoryId: body.categoryId,
						assetId: body.assetId,
					}
				: null;
		case "saveGeneratedBackground":
			return isObject(body.preset)
				? {
						action: body.action,
						preset: body.preset as unknown as GeneratedBackgroundPreset,
					}
				: null;
		case "saveGeneratedEffect":
			return isObject(body.preset)
				? {
						action: body.action,
						preset: body.preset as unknown as GeneratedEffectPreset,
					}
				: null;
		case "saveCaptionPreset":
			return isObject(body.preset)
				? {
						action: body.action,
						preset: body.preset as unknown as SharedCaptionPreset,
					}
				: null;
		default:
			return null;
	}
}

async function handleAudioImport({
	formData,
}: {
	formData: FormData;
}): Promise<NextResponse> {
	const files = formData.getAll("files").filter((file): file is File => file instanceof File);
	const metadata = readMetadataArray({ formData });
	if (!metadata || files.length === 0 || metadata.length !== files.length) {
		return NextResponse.json(
			{ error: "Missing shared audio upload data" },
			{ status: 400 },
		);
	}

	const { libraryRoot, manifestPath, repositoryRoot } =
		await getSharedLibraryPaths();
	const manifest = await readManifest();
	const imported: SharedAudioAsset[] = [];
	const stagedPaths = [manifestPath];

	for (const [index, file] of files.entries()) {
		const input = metadata[index];
		const id = sanitizeId({ value: input.id });
		const folder = input.folder;
		const extension = getExtension({ fileName: file.name });
		if (!id || !isAudioFolder(folder) || !AUDIO_EXTENSIONS.has(extension)) {
			return NextResponse.json(
				{ error: "Unsupported audio upload" },
				{ status: 400 },
			);
		}
		if (file.size > MAX_AUDIO_BYTES) {
			return NextResponse.json(
				{ error: "Audio file is too large" },
				{ status: 413 },
			);
		}

		const storedFileName = `${id}.${extension}`;
		const folderPath = path.join(libraryRoot, "audio", folder);
		const storedPath = path.join(folderPath, storedFileName);
		await mkdir(folderPath, { recursive: true });
		await writeFile(storedPath, Buffer.from(await file.arrayBuffer()));
		stagedPaths.push(storedPath);

		const sourceUrl = `/shared-library/audio/${folder}/${storedFileName}`;
		const asset: SharedAudioAsset = {
			id,
			name: readString({ value: input.name, fallback: file.name }),
			folder,
			mimeType:
				typeof input.mimeType === "string" && input.mimeType.trim()
					? input.mimeType
					: file.type || "audio/mpeg",
			size: file.size,
			...(readOptionalNumber({ value: input.duration }) !== undefined
				? { duration: readOptionalNumber({ value: input.duration }) }
				: {}),
			sourceUrl,
			repositoryPath: toRepositoryPath({
				parts: [
					repositoryRoot,
					"shared-library",
					"audio",
					folder,
					storedFileName,
				],
			}),
			storageKind: "repo",
			fileName: storedFileName,
			createdAt: readString({
				value: input.createdAt,
				fallback: new Date().toISOString(),
			}),
			updatedAt: new Date().toISOString(),
		};
		manifest.audioAssets = upsertById({
			items: manifest.audioAssets,
			item: asset,
		});
		imported.push(asset);
	}

	await writeManifest({ manifest });
	await stageRepositoryAssetPaths({ paths: stagedPaths });
	return NextResponse.json({ assets: imported, manifest: await readManifest() });
}

async function handleStickerImport({
	formData,
}: {
	formData: FormData;
}): Promise<NextResponse> {
	const files = formData.getAll("files").filter((file): file is File => file instanceof File);
	const metadata = readMetadataArray({ formData });
	if (!metadata || files.length === 0 || metadata.length !== files.length) {
		return NextResponse.json(
			{ error: "Missing shared sticker upload data" },
			{ status: 400 },
		);
	}

	const { libraryRoot, manifestPath, repositoryRoot } =
		await getSharedLibraryPaths();
	const manifest = await readManifest();
	const imported: SharedStickerAsset[] = [];
	const stagedPaths = [manifestPath];

	for (const [index, file] of files.entries()) {
		const input = metadata[index];
		const id = sanitizeId({ value: input.id });
		const extension = getExtension({ fileName: file.name });
		if (!id || !STICKER_EXTENSIONS.has(extension)) {
			return NextResponse.json(
				{ error: "Unsupported sticker upload" },
				{ status: 400 },
			);
		}
		if (file.size > MAX_STICKER_BYTES) {
			return NextResponse.json(
				{ error: "Sticker file is too large" },
				{ status: 413 },
			);
		}

		const storedFileName = `${id}.${extension}`;
		const folderPath = path.join(libraryRoot, "stickers");
		const storedPath = path.join(folderPath, storedFileName);
		await mkdir(folderPath, { recursive: true });
		await writeFile(storedPath, Buffer.from(await file.arrayBuffer()));
		stagedPaths.push(storedPath);

		const sourceUrl = `/shared-library/stickers/${storedFileName}`;
		const asset: SharedStickerAsset = {
			id,
			name: readString({ value: input.name, fallback: file.name }),
			mimeType:
				typeof input.mimeType === "string" && input.mimeType.trim()
					? input.mimeType
					: file.type || "image/png",
			size: file.size,
			...(readOptionalNumber({ value: input.width }) !== undefined
				? { width: readOptionalNumber({ value: input.width }) }
				: {}),
			...(readOptionalNumber({ value: input.height }) !== undefined
				? { height: readOptionalNumber({ value: input.height }) }
				: {}),
			sourceUrl,
			repositoryPath: toRepositoryPath({
				parts: [repositoryRoot, "shared-library", "stickers", storedFileName],
			}),
			storageKind: "repo",
			fileName: storedFileName,
			createdAt: readString({
				value: input.createdAt,
				fallback: new Date().toISOString(),
			}),
			updatedAt: new Date().toISOString(),
		};
		manifest.stickerAssets = upsertById({
			items: manifest.stickerAssets,
			item: asset,
		});
		imported.push(asset);
	}

	await writeManifest({ manifest });
	await stageRepositoryAssetPaths({ paths: stagedPaths });
	return NextResponse.json({ assets: imported, manifest: await readManifest() });
}

async function handlePatch({ patch }: { patch: ManifestPatch }): Promise<NextResponse> {
	const manifest = await readManifest();
	const { manifestPath } = await getSharedLibraryPaths();
	switch (patch.action) {
		case "createCategory":
			manifest.categories = upsertById({
				items: manifest.categories,
				item: patch.category,
			});
			break;
		case "addAssetToCategory":
			manifest.categories = manifest.categories.map((category) =>
				category.id === patch.categoryId &&
				!category.assetIds.includes(patch.assetId)
					? {
							...category,
							assetIds: [...category.assetIds, patch.assetId],
							updatedAt: new Date().toISOString(),
						}
					: category,
			);
			break;
		case "removeAssetFromCategory":
			manifest.categories = manifest.categories.map((category) =>
				category.id === patch.categoryId
					? {
							...category,
							assetIds: category.assetIds.filter((id) => id !== patch.assetId),
							updatedAt: new Date().toISOString(),
						}
					: category,
			);
			break;
		case "saveGeneratedBackground":
			manifest.generatedBackgrounds = upsertById({
				items: manifest.generatedBackgrounds,
				item: patch.preset,
			});
			break;
		case "saveGeneratedEffect":
			manifest.generatedEffects = upsertById({
				items: manifest.generatedEffects,
				item: patch.preset,
			});
			break;
		case "saveCaptionPreset":
			manifest.captionPresets = upsertById({
				items: manifest.captionPresets,
				item: patch.preset,
			});
			break;
	}

	await writeManifest({ manifest });
	await stageRepositoryAssetPaths({ paths: [manifestPath] });
	return NextResponse.json({ manifest: await readManifest() });
}

export async function GET() {
	return NextResponse.json({ manifest: await readManifest() });
}

export async function POST(request: Request) {
	try {
		const contentType = request.headers.get("content-type") ?? "";
		if (contentType.includes("multipart/form-data")) {
			const formData = await request.formData();
			const action = formData.get("action");
			if (action === "importAudio") {
				return handleAudioImport({ formData });
			}
			if (action === "importStickers") {
				return handleStickerImport({ formData });
			}
			return NextResponse.json({ error: "Unknown action" }, { status: 400 });
		}

		const patch = parsePatch(await request.json().catch(() => null));
		if (!patch) {
			return NextResponse.json({ error: "Invalid shared library patch" }, { status: 400 });
		}
		return handlePatch({ patch });
	} catch (error) {
		console.error("Failed to update shared library:", error);
		return NextResponse.json(
			{ error: "Failed to update shared library" },
			{ status: 500 },
		);
	}
}
