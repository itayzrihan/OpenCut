import type { MediaAsset } from "@/media/types";
import type { ProjectFontAsset } from "@/fonts/types";
import type { TProject } from "@/project/types";
import { storageService } from "@/services/storage/service";
import type {
	SerializedCommandHistory,
	SerializedCommandHistoryEntry,
	SerializedProjectHistorySnapshot,
} from "@/services/storage/types";
import {
	sharedLibraryService,
	type SharedAudioAsset,
	type SharedStickerAsset,
} from "@/shared-library";
import type { TimelineElement, TimelineTrack } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { createZipBlob, readZipEntries, type ZipEntryInput } from "./zip";

const ARCHIVE_SCHEMA = "opencut.project.archive";
const ARCHIVE_VERSION = 1;
const MANIFEST_PATH = "manifest.json";
const PROJECT_PATH = "project.json";
const COMMAND_HISTORY_PATH = "command-history.json";
const USER_STICKERS_PROVIDER_ID = "user-stickers";

export const PROJECT_ARCHIVE_MIME_TYPE = "application/zip";
export const PROJECT_ARCHIVE_EXTENSION = ".opencut.zip";
export const PROJECT_ARCHIVE_ACCEPT = ".opencut.zip,.zip,application/zip";

interface ArchiveMediaAsset {
	id: string;
	name: string;
	type: MediaAsset["type"];
	fileName: string;
	mimeType: string;
	path?: string;
	storageKind?: "copied" | "linked";
	sourcePath?: string;
	size: number;
	lastModified: number;
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	hasAudio?: boolean;
	ephemeral?: boolean;
	thumbnailUrl?: string;
}

interface ArchiveProjectFont {
	id: string;
	family: string;
	fileName: string;
	mimeType: string;
	path: string;
	size: number;
	lastModified: number;
	createdAt: string;
	sourceUrl?: string;
	repositoryPath?: string;
}

interface ArchiveSharedAudio {
	asset: SharedAudioAsset;
	fileName?: string;
	path?: string;
}

interface ArchiveSharedSticker {
	asset: SharedStickerAsset;
	fileName?: string;
	path?: string;
}

interface ProjectArchiveManifest {
	schema: typeof ARCHIVE_SCHEMA;
	version: typeof ARCHIVE_VERSION;
	exportedAt: string;
	projectId: string;
	project: {
		path: typeof PROJECT_PATH;
	};
	commandHistory?: {
		path: typeof COMMAND_HISTORY_PATH;
	};
	mediaAssets: ArchiveMediaAsset[];
	projectFonts: ArchiveProjectFont[];
	sharedAudioAssets: ArchiveSharedAudio[];
	sharedStickerAssets: ArchiveSharedSticker[];
}

export interface CreateProjectArchiveArgs {
	project: TProject;
	mediaAssets: MediaAsset[];
	projectFonts: ProjectFontAsset[];
	commandHistory: SerializedCommandHistory | null;
}

export interface ImportProjectArchiveResult {
	projectId: string;
	projectName: string;
	mediaImported: number;
	fontsImported: number;
	sharedAudioImported: number;
	sharedAudioLinked: number;
	sharedStickersImported: number;
	sharedStickersLinked: number;
	wasProjectIdRemapped: boolean;
}

function jsonStringify(value: unknown): string {
	return `${JSON.stringify(
		value,
		(key, nestedValue) => (key === "buffer" ? undefined : nestedValue),
		2,
	)}\n`;
}

function safeFileName({
	name,
	fallback,
}: {
	name: string | undefined;
	fallback: string;
}): string {
	const source = name || fallback;
	let withoutUnsafeChars = "";
	for (const char of source) {
		const code = char.charCodeAt(0);
		withoutUnsafeChars += code < 32 || '<>:"/\\|?*'.includes(char) ? "_" : char;
	}
	const cleaned = withoutUnsafeChars.replace(/\s+/g, " ").trim();
	return cleaned || fallback;
}

function safePathSegment({ value }: { value: string }): string {
	return safeFileName({ name: value, fallback: "asset" }).replaceAll(".", "_");
}

function getArchiveFilePath({
	kind,
	id,
	fileName,
}: {
	kind: "media" | "fonts" | "shared-audio" | "shared-stickers";
	id: string;
	fileName: string;
}): string {
	return `${kind}/${safePathSegment({ value: id })}/${safeFileName({
		name: fileName,
		fallback: id,
	})}`;
}

function projectArchiveFileName({
	projectName,
}: {
	projectName: string;
}): string {
	return `${safeFileName({
		name: projectName,
		fallback: "OpenCut project",
	})}${PROJECT_ARCHIVE_EXTENSION}`;
}

export function downloadProjectArchive({
	blob,
	projectName,
}: {
	blob: Blob;
	projectName: string;
}): void {
	const url = URL.createObjectURL(blob);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	downloadLink.download = projectArchiveFileName({ projectName });
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
	URL.revokeObjectURL(url);
}

function getSceneTracks({ project }: { project: TProject }): TimelineTrack[] {
	return project.scenes.flatMap((scene) => [
		...scene.tracks.overlay,
		scene.tracks.main,
		...scene.tracks.audio,
	]);
}

function getReferencedSharedAssetIds({ project }: { project: TProject }): {
	audioIds: string[];
	stickerIds: string[];
} {
	const audioIds = new Set<string>();
	const stickerIds = new Set<string>();

	for (const track of getSceneTracks({ project })) {
		for (const element of track.elements as TimelineElement[]) {
			if (
				element.type === "audio" &&
				element.sourceType === "library" &&
				element.librarySourceType === "shared" &&
				element.libraryAssetId
			) {
				audioIds.add(element.libraryAssetId);
			}

			if (element.type === "sticker") {
				const separatorIndex = element.stickerId.indexOf(":");
				const provider =
					separatorIndex > 0 ? element.stickerId.slice(0, separatorIndex) : "";
				const providerValue =
					separatorIndex > 0 ? element.stickerId.slice(separatorIndex + 1) : "";
				if (provider === USER_STICKERS_PROVIDER_ID && providerValue) {
					stickerIds.add(providerValue);
				}
			}
		}
	}

	return {
		audioIds: [...audioIds],
		stickerIds: [...stickerIds],
	};
}

async function collectSharedAudioForArchive({
	audioIds,
	entries,
}: {
	audioIds: string[];
	entries: ZipEntryInput[];
}): Promise<ArchiveSharedAudio[]> {
	if (audioIds.length === 0) return [];

	const assets = await sharedLibraryService.listAudioAssets();
	const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
	const result: ArchiveSharedAudio[] = [];

	for (const id of audioIds) {
		const asset = assetsById.get(id);
		if (!asset) continue;

		const file = await sharedLibraryService
			.getAudioAssetFile({ id })
			.catch(() => null);
		if (!file) {
			result.push({ asset });
			continue;
		}

		const fileName = safeFileName({
			name: file.name || asset.fileName,
			fallback: `${id}.audio`,
		});
		const path = getArchiveFilePath({
			kind: "shared-audio",
			id,
			fileName,
		});
		entries.push({
			path,
			data: file,
			lastModified: new Date(asset.updatedAt),
		});
		result.push({ asset, fileName, path });
	}

	return result;
}

async function collectSharedStickersForArchive({
	stickerIds,
	entries,
}: {
	stickerIds: string[];
	entries: ZipEntryInput[];
}): Promise<ArchiveSharedSticker[]> {
	if (stickerIds.length === 0) return [];

	const assets = await sharedLibraryService.listStickerAssets();
	const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
	const result: ArchiveSharedSticker[] = [];

	for (const id of stickerIds) {
		const asset = assetsById.get(id);
		if (!asset) continue;

		const file = await sharedLibraryService
			.getStickerAssetFile({ id })
			.catch(() => null);
		if (!file) {
			result.push({ asset });
			continue;
		}

		const fileName = safeFileName({
			name: file.name || asset.fileName,
			fallback: `${id}.image`,
		});
		const path = getArchiveFilePath({
			kind: "shared-stickers",
			id,
			fileName,
		});
		entries.push({
			path,
			data: file,
			lastModified: new Date(asset.updatedAt),
		});
		result.push({ asset, fileName, path });
	}

	return result;
}

async function appendMediaEntries({
	entries,
	mediaAssets,
}: {
	entries: ZipEntryInput[];
	mediaAssets: MediaAsset[];
}): Promise<ArchiveMediaAsset[]> {
	const manifest: ArchiveMediaAsset[] = [];
	for (const asset of mediaAssets) {
		const fileName = safeFileName({
			name: asset.file?.name || asset.fileName || asset.name,
			fallback: `${asset.id}.media`,
		});
		let path: string | undefined;
		if (asset.storageKind !== "linked") {
			let file = asset.file;
			if (!file && asset.url) {
				const response = await fetch(asset.url);
				if (!response.ok) {
					throw new Error(
						`Could not read ${asset.name} for the project archive`,
					);
				}
				const blob = await response.blob();
				file = new File([blob], fileName, {
					type: asset.mimeType || blob.type,
					lastModified: asset.lastModified ?? Date.now(),
				});
			}
			if (!file) throw new Error(`Media source is missing for ${asset.name}`);
			path = getArchiveFilePath({ kind: "media", id: asset.id, fileName });
			entries.push({
				path,
				data: file,
				lastModified: new Date(asset.lastModified ?? Date.now()),
			});
		}
		manifest.push({
			id: asset.id,
			name: asset.name,
			type: asset.type,
			fileName,
			mimeType:
				asset.file?.type || asset.mimeType || "application/octet-stream",
			path,
			storageKind: asset.storageKind,
			sourcePath: asset.storageKind === "linked" ? asset.sourcePath : undefined,
			size: asset.file?.size ?? asset.size ?? 0,
			lastModified:
				asset.file?.lastModified ?? asset.lastModified ?? Date.now(),
			width: asset.width,
			height: asset.height,
			duration: asset.duration,
			fps: asset.fps,
			hasAudio: asset.hasAudio,
			ephemeral: asset.ephemeral,
			thumbnailUrl: asset.thumbnailUrl,
		});
	}
	return manifest;
}

function appendProjectFontEntries({
	entries,
	projectFonts,
}: {
	entries: ZipEntryInput[];
	projectFonts: ProjectFontAsset[];
}): ArchiveProjectFont[] {
	return projectFonts.map((font) => {
		const fileName = safeFileName({
			name: font.file.name || font.fileName,
			fallback: `${font.id}.font`,
		});
		const path = getArchiveFilePath({
			kind: "fonts",
			id: font.id,
			fileName,
		});
		entries.push({
			path,
			data: font.file,
			lastModified: new Date(font.file.lastModified),
		});
		return {
			id: font.id,
			family: font.family,
			fileName,
			mimeType: font.mimeType || font.file.type || "font/ttf",
			path,
			size: font.file.size,
			lastModified: font.file.lastModified,
			createdAt: font.createdAt,
			sourceUrl: font.sourceUrl,
			repositoryPath: font.repositoryPath,
		};
	});
}

export async function createProjectArchive({
	project,
	mediaAssets,
	projectFonts,
	commandHistory,
}: CreateProjectArchiveArgs): Promise<Blob> {
	const entries: ZipEntryInput[] = [
		{
			path: PROJECT_PATH,
			data: jsonStringify(project),
			lastModified: project.metadata.updatedAt,
		},
	];
	const mediaManifest = await appendMediaEntries({ entries, mediaAssets });
	const fontManifest = appendProjectFontEntries({ entries, projectFonts });
	const sharedRefs = getReferencedSharedAssetIds({ project });
	const [sharedAudioAssets, sharedStickerAssets] = await Promise.all([
		collectSharedAudioForArchive({
			audioIds: sharedRefs.audioIds,
			entries,
		}),
		collectSharedStickersForArchive({
			stickerIds: sharedRefs.stickerIds,
			entries,
		}),
	]);

	if (commandHistory) {
		entries.push({
			path: COMMAND_HISTORY_PATH,
			data: jsonStringify(commandHistory),
			lastModified: new Date(commandHistory.updatedAt),
		});
	}

	const manifest: ProjectArchiveManifest = {
		schema: ARCHIVE_SCHEMA,
		version: ARCHIVE_VERSION,
		exportedAt: new Date().toISOString(),
		projectId: project.metadata.id,
		project: { path: PROJECT_PATH },
		...(commandHistory
			? { commandHistory: { path: COMMAND_HISTORY_PATH } }
			: {}),
		mediaAssets: mediaManifest,
		projectFonts: fontManifest,
		sharedAudioAssets,
		sharedStickerAssets,
	};

	return createZipBlob({
		entries: [
			{
				path: MANIFEST_PATH,
				data: jsonStringify(manifest),
				lastModified: new Date(manifest.exportedAt),
			},
			...entries,
		],
	});
}

function isArchiveManifest(value: unknown): value is ProjectArchiveManifest {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as ProjectArchiveManifest).schema === ARCHIVE_SCHEMA &&
		(value as ProjectArchiveManifest).version === ARCHIVE_VERSION &&
		Array.isArray((value as ProjectArchiveManifest).mediaAssets) &&
		Array.isArray((value as ProjectArchiveManifest).projectFonts) &&
		Array.isArray((value as ProjectArchiveManifest).sharedAudioAssets) &&
		Array.isArray((value as ProjectArchiveManifest).sharedStickerAssets)
	);
}

function reviveProject({ value }: { value: unknown }): TProject {
	const project = value as TProject & {
		metadata: TProject["metadata"] & { createdAt: string; updatedAt: string };
		scenes: Array<
			TProject["scenes"][number] & { createdAt: string; updatedAt: string }
		>;
	};

	if (
		!project?.metadata?.id ||
		!project.metadata.name ||
		!Array.isArray(project.scenes)
	) {
		throw new Error("Invalid OpenCut project archive");
	}

	return {
		...project,
		metadata: {
			...project.metadata,
			createdAt: new Date(project.metadata.createdAt),
			updatedAt: new Date(project.metadata.updatedAt),
		},
		scenes: project.scenes.map((scene) => ({
			...scene,
			createdAt: new Date(scene.createdAt),
			updatedAt: new Date(scene.updatedAt),
		})),
	};
}

async function readRequiredFile({
	entries,
	path,
	fileName,
	mimeType,
	lastModified,
}: {
	entries: Awaited<ReturnType<typeof readZipEntries>>;
	path: string;
	fileName: string;
	mimeType: string;
	lastModified: number;
}): Promise<File> {
	const entry = entries.get(path);
	if (!entry) {
		throw new Error(`Invalid OpenCut project archive: missing ${path}`);
	}

	return new File([entry.blob], fileName, {
		type: mimeType || "application/octet-stream",
		lastModified,
	});
}

async function readOptionalFile({
	entries,
	path,
	fileName,
	mimeType,
	lastModified,
}: {
	entries: Awaited<ReturnType<typeof readZipEntries>>;
	path?: string;
	fileName?: string;
	mimeType: string;
	lastModified: number;
}): Promise<File | null> {
	if (!path) return null;
	return readRequiredFile({
		entries,
		path,
		fileName: fileName ?? "asset",
		mimeType,
		lastModified,
	});
}

async function getUnusedProjectId({ preferredId }: { preferredId: string }) {
	const existing = await storageService.loadProject({ id: preferredId });
	if (!existing) return { projectId: preferredId, remapped: false };

	let projectId = generateUUID();
	while (await storageService.loadProject({ id: projectId })) {
		projectId = generateUUID();
	}
	return { projectId, remapped: true };
}

function remapProjectId({
	project,
	projectId,
}: {
	project: TProject;
	projectId: string;
}): TProject {
	return {
		...project,
		metadata: {
			...project.metadata,
			id: projectId,
		},
	};
}

function remapSnapshotProjectId({
	snapshot,
	fromProjectId,
	toProjectId,
}: {
	snapshot: SerializedProjectHistorySnapshot;
	fromProjectId: string;
	toProjectId: string;
}): SerializedProjectHistorySnapshot {
	return {
		...snapshot,
		metadata: {
			...snapshot.metadata,
			id:
				snapshot.metadata.id === fromProjectId
					? toProjectId
					: snapshot.metadata.id,
		},
	};
}

function remapHistoryEntry({
	entry,
	fromProjectId,
	toProjectId,
}: {
	entry: SerializedCommandHistoryEntry;
	fromProjectId: string;
	toProjectId: string;
}): SerializedCommandHistoryEntry {
	return {
		...entry,
		before: remapSnapshotProjectId({
			snapshot: entry.before,
			fromProjectId,
			toProjectId,
		}),
		after: remapSnapshotProjectId({
			snapshot: entry.after,
			fromProjectId,
			toProjectId,
		}),
	};
}

function remapCommandHistory({
	history,
	fromProjectId,
	toProjectId,
}: {
	history: SerializedCommandHistory;
	fromProjectId: string;
	toProjectId: string;
}): SerializedCommandHistory {
	return {
		...history,
		projectId: toProjectId,
		undoStack: history.undoStack.map((entry) =>
			remapHistoryEntry({ entry, fromProjectId, toProjectId }),
		),
		redoStack: history.redoStack.map((entry) =>
			remapHistoryEntry({ entry, fromProjectId, toProjectId }),
		),
	};
}

function remapSharedReferences({
	project,
	audioIdMap,
	stickerIdMap,
}: {
	project: TProject;
	audioIdMap: Map<string, string>;
	stickerIdMap: Map<string, string>;
}): TProject {
	if (audioIdMap.size === 0 && stickerIdMap.size === 0) return project;

	return {
		...project,
		scenes: project.scenes.map((scene) => ({
			...scene,
			tracks: {
				...scene.tracks,
				overlay: scene.tracks.overlay.map((track) =>
					remapSharedReferencesInTrack({ track, audioIdMap, stickerIdMap }),
				),
				main: remapSharedReferencesInTrack({
					track: scene.tracks.main,
					audioIdMap,
					stickerIdMap,
				}),
				audio: scene.tracks.audio.map((track) =>
					remapSharedReferencesInTrack({ track, audioIdMap, stickerIdMap }),
				),
			},
		})),
	};
}

function remapSharedReferencesInTrack<TTrack extends TimelineTrack>({
	track,
	audioIdMap,
	stickerIdMap,
}: {
	track: TTrack;
	audioIdMap: Map<string, string>;
	stickerIdMap: Map<string, string>;
}): TTrack {
	return {
		...track,
		elements: (track.elements as TimelineElement[]).map((element) => {
			if (
				element.type === "audio" &&
				element.sourceType === "library" &&
				element.libraryAssetId
			) {
				const mappedId = audioIdMap.get(element.libraryAssetId);
				return mappedId ? { ...element, libraryAssetId: mappedId } : element;
			}

			if (element.type === "sticker") {
				const prefix = `${USER_STICKERS_PROVIDER_ID}:`;
				if (!element.stickerId.startsWith(prefix)) return element;
				const originalId = element.stickerId.slice(prefix.length);
				const mappedId = stickerIdMap.get(originalId);
				return mappedId
					? { ...element, stickerId: `${prefix}${mappedId}` }
					: element;
			}

			return element;
		}) as typeof track.elements,
	} as TTrack;
}

async function getRequiredImportBytes({
	manifest,
	entries,
	existingAudioIds,
	existingStickerIds,
}: {
	manifest: ProjectArchiveManifest;
	entries: Awaited<ReturnType<typeof readZipEntries>>;
	existingAudioIds: Set<string>;
	existingStickerIds: Set<string>;
}): Promise<number> {
	let size = 0;
	for (const asset of manifest.mediaAssets) {
		if (asset.path)
			size += entries.get(asset.path)?.uncompressedSize ?? asset.size;
	}
	for (const font of manifest.projectFonts) {
		size += entries.get(font.path)?.uncompressedSize ?? font.size;
	}
	for (const sharedAudio of manifest.sharedAudioAssets) {
		if (existingAudioIds.has(sharedAudio.asset.id) || !sharedAudio.path)
			continue;
		size +=
			entries.get(sharedAudio.path)?.uncompressedSize ?? sharedAudio.asset.size;
	}
	for (const sharedSticker of manifest.sharedStickerAssets) {
		if (existingStickerIds.has(sharedSticker.asset.id) || !sharedSticker.path) {
			continue;
		}
		size +=
			entries.get(sharedSticker.path)?.uncompressedSize ??
			sharedSticker.asset.size;
	}
	return size;
}

async function importSharedAudioAssets({
	manifest,
	entries,
}: {
	manifest: ProjectArchiveManifest;
	entries: Awaited<ReturnType<typeof readZipEntries>>;
}): Promise<{
	audioIdMap: Map<string, string>;
	imported: number;
	linked: number;
}> {
	const audioIdMap = new Map<string, string>();
	let imported = 0;
	let linked = 0;

	for (const item of manifest.sharedAudioAssets) {
		const file = await readOptionalFile({
			entries,
			path: item.path,
			fileName: item.fileName ?? item.asset.fileName ?? item.asset.name,
			mimeType: item.asset.mimeType,
			lastModified: new Date(item.asset.updatedAt).getTime(),
		});
		const result = await sharedLibraryService.upsertArchiveAudioAsset({
			asset: item.asset,
			file,
		});
		audioIdMap.set(item.asset.id, result.assetId);
		if (result.status === "linked") {
			linked += 1;
		} else {
			imported += 1;
		}
	}

	return { audioIdMap, imported, linked };
}

async function importSharedStickerAssets({
	manifest,
	entries,
}: {
	manifest: ProjectArchiveManifest;
	entries: Awaited<ReturnType<typeof readZipEntries>>;
}): Promise<{
	stickerIdMap: Map<string, string>;
	imported: number;
	linked: number;
}> {
	const stickerIdMap = new Map<string, string>();
	let imported = 0;
	let linked = 0;

	for (const item of manifest.sharedStickerAssets) {
		const file = await readOptionalFile({
			entries,
			path: item.path,
			fileName: item.fileName ?? item.asset.fileName ?? item.asset.name,
			mimeType: item.asset.mimeType,
			lastModified: new Date(item.asset.updatedAt).getTime(),
		});
		const result = await sharedLibraryService.upsertArchiveStickerAsset({
			asset: item.asset,
			file,
		});
		stickerIdMap.set(item.asset.id, result.assetId);
		if (result.status === "linked") {
			linked += 1;
		} else {
			imported += 1;
		}
	}

	return { stickerIdMap, imported, linked };
}

export async function importProjectArchive({
	file,
}: {
	file: File;
}): Promise<ImportProjectArchiveResult> {
	const entries = await readZipEntries({ blob: file });
	const manifestEntry = entries.get(MANIFEST_PATH);
	if (!manifestEntry) {
		throw new Error("Invalid OpenCut project archive: missing manifest");
	}

	const manifestValue = await manifestEntry.json();
	if (!isArchiveManifest(manifestValue)) {
		throw new Error("Invalid OpenCut project archive");
	}
	const manifest = manifestValue;

	const projectEntry = entries.get(manifest.project.path);
	if (!projectEntry) {
		throw new Error("Invalid OpenCut project archive: missing project");
	}

	const sourceProject = reviveProject({ value: await projectEntry.json() });
	const [{ projectId, remapped }, existingAudioAssets, existingStickerAssets] =
		await Promise.all([
			getUnusedProjectId({ preferredId: sourceProject.metadata.id }),
			sharedLibraryService.listAudioAssets(),
			sharedLibraryService.listStickerAssets(),
		]);

	const requiredBytes = await getRequiredImportBytes({
		manifest,
		entries,
		existingAudioIds: new Set(existingAudioAssets.map((asset) => asset.id)),
		existingStickerIds: new Set(existingStickerAssets.map((asset) => asset.id)),
	});
	const capacity = await storageService.canStoreFile({ size: requiredBytes });
	if (!capacity.canStore) {
		throw new Error(
			"Not enough browser storage to import this project archive",
		);
	}

	const [sharedAudioResult, sharedStickerResult] = await Promise.all([
		importSharedAudioAssets({ manifest, entries }),
		importSharedStickerAssets({ manifest, entries }),
	]);

	const projectWithSharedReferences = remapSharedReferences({
		project: sourceProject,
		audioIdMap: sharedAudioResult.audioIdMap,
		stickerIdMap: sharedStickerResult.stickerIdMap,
	});
	const project = remapProjectId({
		project: projectWithSharedReferences,
		projectId,
	});

	let didSaveProject = false;
	try {
		await storageService.saveProject({ project });
		didSaveProject = true;

		for (const asset of manifest.mediaAssets) {
			const mediaFile = asset.path
				? await readRequiredFile({
						entries,
						path: asset.path,
						fileName: asset.fileName,
						mimeType: asset.mimeType,
						lastModified: asset.lastModified,
					})
				: undefined;
			if (!mediaFile && !asset.sourcePath) {
				throw new Error(
					`Archive media ${asset.name} has neither bytes nor a source path`,
				);
			}
			await storageService.saveMediaAsset({
				projectId,
				mediaAsset: {
					id: asset.id,
					name: asset.name,
					type: asset.type,
					file: mediaFile,
					size: mediaFile?.size ?? asset.size,
					lastModified: mediaFile?.lastModified ?? asset.lastModified,
					fileName: asset.fileName,
					mimeType: asset.mimeType,
					storageKind: asset.storageKind,
					sourcePath: asset.sourcePath,
					width: asset.width,
					height: asset.height,
					duration: asset.duration,
					fps: asset.fps,
					hasAudio: asset.hasAudio,
					ephemeral: asset.ephemeral,
					thumbnailUrl: asset.thumbnailUrl,
				},
			});
		}

		for (const font of manifest.projectFonts) {
			const fontFile = await readRequiredFile({
				entries,
				path: font.path,
				fileName: font.fileName,
				mimeType: font.mimeType,
				lastModified: font.lastModified,
			});
			await storageService.saveProjectFont({
				projectId,
				font: {
					id: font.id,
					family: font.family,
					fileName: font.fileName,
					mimeType: font.mimeType,
					size: font.size,
					lastModified: font.lastModified,
					createdAt: font.createdAt,
					sourceUrl: font.sourceUrl,
					repositoryPath: font.repositoryPath,
					file: fontFile,
				},
			});
		}

		if (manifest.commandHistory) {
			const historyEntry = entries.get(manifest.commandHistory.path);
			if (historyEntry) {
				const history = remapCommandHistory({
					history: await historyEntry.json<SerializedCommandHistory>(),
					fromProjectId: sourceProject.metadata.id,
					toProjectId: projectId,
				});
				await storageService.saveCommandHistory({ history });
			}
		}
	} catch (error) {
		if (didSaveProject) {
			await Promise.allSettled([
				storageService.deleteProjectMedia({ projectId }),
				storageService.deleteProjectFonts({ projectId }),
				storageService.deleteProject({ id: projectId }),
			]);
		}
		throw error;
	}

	return {
		projectId,
		projectName: project.metadata.name,
		mediaImported: manifest.mediaAssets.length,
		fontsImported: manifest.projectFonts.length,
		sharedAudioImported: sharedAudioResult.imported,
		sharedAudioLinked: sharedAudioResult.linked,
		sharedStickersImported: sharedStickerResult.imported,
		sharedStickersLinked: sharedStickerResult.linked,
		wasProjectIdRemapped: remapped,
	};
}
