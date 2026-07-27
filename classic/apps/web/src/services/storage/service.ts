import type { ProjectFontAsset } from "@/fonts/types";
import type { MediaAsset } from "@/media/types";
import type { TProject, TProjectMetadata } from "@/project/types";
import type { SavedSound, SavedSoundsData, SoundEffect } from "@/sounds/types";
import type { Bookmark, SceneTracks, TScene } from "@/timeline";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import { roundMediaTime } from "@/wasm";
import {
	loadLocalFontFile,
	localDriveRequest,
	localFontUrl,
	localMediaUrl,
	uploadLocalFont,
	uploadLocalMedia,
} from "@/services/local-drive/client";
import type { LocalDriveMediaRecord } from "@/services/local-drive/types";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import { OPFSAdapter } from "./opfs-adapter";
import type { StorageCapacityCheckResult } from "./quota";
import { isStorageQuotaExceededError } from "./quota";
import type {
	MediaAssetData,
	ProjectFontData,
	SerializedCommandHistory,
	SerializedProject,
	SerializedScene,
	StorageConfig,
} from "./types";
import type { StorageMigrationRunnerDependencies } from "./migrations/runner";
import type { ProjectRecord } from "./migrations/transformers/types";
import { persistProjectMigrationBackup } from "./migrations/migration-backups";

const BROWSER_MIGRATION_KEY = "pocut-local-drive-migration-v1";

function normalizeBookmarks({ raw }: { raw: unknown }): Bookmark[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): Bookmark | null => {
			if (typeof item === "number") {
				return { time: roundMediaTime({ time: item }) };
			}
			const obj = item as Record<string, unknown>;
			if (
				typeof obj !== "object" ||
				obj === null ||
				typeof obj.time !== "number"
			) {
				return null;
			}
			return {
				time: roundMediaTime({ time: obj.time }),
				...(typeof obj.note === "string" && { note: obj.note }),
				...(typeof obj.color === "string" && { color: obj.color }),
				...(typeof obj.duration === "number" && {
					duration: roundMediaTime({ time: obj.duration }),
				}),
			};
		})
		.filter((bookmark): bookmark is Bookmark => bookmark !== null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredDate(value: unknown): Date | null {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
	}
	if (typeof value !== "string" && typeof value !== "number") return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function readStoredProjectId(entry: unknown): string | undefined {
	if (!isRecord(entry)) return undefined;
	if (typeof entry.id === "string") return entry.id;
	if (isRecord(entry.metadata) && typeof entry.metadata.id === "string") {
		return entry.metadata.id;
	}
	return undefined;
}

function readProjectMetadata(entry: unknown): TProjectMetadata | null {
	if (!isRecord(entry) || !isRecord(entry.metadata)) return null;
	const metadata = entry.metadata;
	const id =
		typeof metadata.id === "string"
			? metadata.id
			: typeof entry.id === "string"
				? entry.id
				: null;
	const name = typeof metadata.name === "string" ? metadata.name : null;
	const createdAt = parseStoredDate(metadata.createdAt);
	const updatedAt = parseStoredDate(metadata.updatedAt);
	if (!id || name === null || !createdAt || !updatedAt) return null;

	let duration = 0;
	if (
		typeof metadata.duration === "number" &&
		Number.isFinite(metadata.duration)
	) {
		duration = metadata.duration;
	} else {
		try {
			duration = getProjectDurationFromScenes({
				scenes: (Array.isArray(entry.scenes) ? entry.scenes : []) as TScene[],
			});
		} catch {
			duration = 0;
		}
	}

	return {
		id,
		name,
		...(typeof metadata.thumbnail === "string" && {
			thumbnail: metadata.thumbnail,
		}),
		duration: roundMediaTime({ time: duration }),
		createdAt,
		updatedAt,
	};
}

function deserializeProject(serializedProject: SerializedProject): TProject {
	const scenes =
		serializedProject.scenes?.map((scene) => ({
			id: scene.id,
			name: scene.name,
			isMain: scene.isMain,
			tracks: scene.tracks,
			bookmarks: normalizeBookmarks({ raw: scene.bookmarks }),
			createdAt: new Date(scene.createdAt),
			updatedAt: new Date(scene.updatedAt),
		})) ?? [];

	return {
		metadata: {
			id: serializedProject.metadata.id,
			name: serializedProject.metadata.name,
			thumbnail: serializedProject.metadata.thumbnail,
			duration: roundMediaTime({
				time:
					serializedProject.metadata.duration ??
					getProjectDurationFromScenes({ scenes }),
			}),
			createdAt: new Date(serializedProject.metadata.createdAt),
			updatedAt: new Date(serializedProject.metadata.updatedAt),
		},
		scenes,
		currentSceneId: serializedProject.currentSceneId || "",
		settings: serializedProject.settings,
		customFonts: serializedProject.customFonts,
		aiEditHistory: serializedProject.aiEditHistory ?? [],
		version: serializedProject.version,
		timelineViewState: serializedProject.timelineViewState,
	};
}

export class StorageService {
	private projectsAdapter: IndexedDBAdapter<SerializedProject>;
	private commandHistoryAdapter: IndexedDBAdapter<SerializedCommandHistory>;
	private savedSoundsAdapter: IndexedDBAdapter<SavedSoundsData>;
	private config: StorageConfig;
	private browserMigrationPromise: Promise<void> | null = null;

	constructor() {
		this.config = {
			projectsDb: "video-editor-projects",
			mediaDb: "video-editor-media",
			fontsDb: "video-editor-fonts",
			commandHistoryDb: "video-editor-command-history",
			savedSoundsDb: "video-editor-saved-sounds",
			version: 1,
		};
		this.projectsAdapter = new IndexedDBAdapter<SerializedProject>({
			dbName: this.config.projectsDb,
			storeName: "projects",
			version: this.config.version,
		});
		this.commandHistoryAdapter = new IndexedDBAdapter<SerializedCommandHistory>(
			{
				dbName: this.config.commandHistoryDb,
				storeName: "command-history",
				version: this.config.version,
			},
		);
		this.savedSoundsAdapter = new IndexedDBAdapter<SavedSoundsData>({
			dbName: this.config.savedSoundsDb,
			storeName: "saved-sounds",
			version: this.config.version,
		});
	}

	private getLegacyMediaAdapters(projectId: string) {
		return {
			metadata: new IndexedDBAdapter<MediaAssetData>({
				dbName: `${this.config.mediaDb}-${projectId}`,
				storeName: "media-metadata",
				version: this.config.version,
			}),
			files: new OPFSAdapter(`media-files-${projectId}`),
		};
	}

	private getLegacyFontAdapters(projectId: string) {
		return {
			metadata: new IndexedDBAdapter<ProjectFontData>({
				dbName: `${this.config.fontsDb}-${projectId}`,
				storeName: "font-metadata",
				version: this.config.version,
			}),
			files: new OPFSAdapter(`font-files-${projectId}`),
		};
	}

	async ensureBrowserDataMigrated(): Promise<void> {
		if (this.browserMigrationPromise) return this.browserMigrationPromise;
		this.browserMigrationPromise = this.migrateBrowserData().catch((error) => {
			this.browserMigrationPromise = null;
			throw error;
		});
		return this.browserMigrationPromise;
	}

	createDriveMigrationDependencies(): StorageMigrationRunnerDependencies {
		return {
			projectsStorage: {
				getAll: () =>
					localDriveRequest<ProjectRecord[]>({ operation: "project.list" }),
				set: ({ key, value }) =>
					localDriveRequest({
						operation: "project.put",
						payload: { projectId: key, project: value },
					}),
			},
			persistBackup: persistProjectMigrationBackup,
			cleanupLegacyMetaDatabase: async () => undefined,
			now: Date.now,
			wait: (milliseconds) =>
				new Promise((resolve) => setTimeout(resolve, milliseconds)),
			minimumDisplayMs: 0,
		};
	}

	private async migrateBrowserData(): Promise<void> {
		await localDriveRequest({ operation: "status" });
		if (typeof indexedDB === "undefined") return;
		try {
			if (localStorage.getItem(BROWSER_MIGRATION_KEY) === "complete") return;
		} catch {
			// Continue without a marker when localStorage is restricted.
		}

		const legacyProjects = await this.projectsAdapter.getAll();
		for (const serializedProject of legacyProjects) {
			const projectId = readStoredProjectId(serializedProject);
			if (!projectId) continue;
			const driveProject = await localDriveRequest<SerializedProject | null>({
				operation: "project.get",
				payload: { projectId },
			});
			if (!driveProject) {
				await localDriveRequest({
					operation: "project.put",
					payload: { projectId, project: serializedProject },
				});
			}

			const driveHistory =
				await localDriveRequest<SerializedCommandHistory | null>({
					operation: "history.get",
					payload: { projectId },
				});
			if (!driveHistory) {
				const history = await this.commandHistoryAdapter.get(projectId);
				if (history) {
					await localDriveRequest({
						operation: "history.put",
						payload: { projectId, history },
					});
				}
			}

			const driveMedia = await localDriveRequest<LocalDriveMediaRecord[]>({
				operation: "media.list",
				payload: { projectId },
			});
			const driveMediaIds = new Set(driveMedia.map((item) => item.id));
			const legacyMedia = this.getLegacyMediaAdapters(projectId);
			for (const metadata of await legacyMedia.metadata.getAll()) {
				if (driveMediaIds.has(metadata.id)) continue;
				const file = await legacyMedia.files.get(metadata.id);
				if (!file) continue;
				await uploadLocalMedia({
					projectId,
					id: metadata.id,
					file,
					migration: true,
				});
				await localDriveRequest({
					operation: "media.put",
					payload: {
						projectId,
						media: {
							...metadata,
							fileName: file.name || metadata.name,
							mimeType: file.type || "application/octet-stream",
							storageKind: "copied",
							sourcePath: "",
						},
					},
				});
			}

			const driveFonts = await localDriveRequest<ProjectFontData[]>({
				operation: "font.list",
				payload: { projectId },
			});
			const driveFontIds = new Set(driveFonts.map((item) => item.id));
			const legacyFonts = this.getLegacyFontAdapters(projectId);
			for (const metadata of await legacyFonts.metadata.getAll()) {
				if (driveFontIds.has(metadata.id)) continue;
				const file = await legacyFonts.files.get(metadata.id);
				if (!file) continue;
				const storedPath = await uploadLocalFont({
					projectId,
					id: metadata.id,
					file,
				});
				await localDriveRequest({
					operation: "font.put",
					payload: { projectId, font: metadata, storedPath },
				});
			}
		}

		const driveSounds = await localDriveRequest<SavedSoundsData | null>({
			operation: "sounds.get",
		});
		if (!driveSounds) {
			const browserSounds = await this.savedSoundsAdapter.get("user-sounds");
			if (browserSounds) {
				await localDriveRequest({
					operation: "sounds.put",
					payload: { sounds: browserSounds },
				});
			}
		}

		try {
			localStorage.setItem(BROWSER_MIGRATION_KEY, "complete");
		} catch {
			// The next load will perform an inexpensive merge check again.
		}
	}

	async canStoreFile({
		size: _size,
	}: {
		size: number;
	}): Promise<StorageCapacityCheckResult> {
		await localDriveRequest({ operation: "status" });
		return {
			canStore: true,
			reason: "estimate-unavailable",
			availableBytes: null,
		};
	}

	isQuotaExceededError({ error }: { error: unknown }): boolean {
		return isStorageQuotaExceededError({ error });
	}

	private stripAudioBuffers({ tracks }: { tracks: SceneTracks }): SceneTracks {
		return {
			...tracks,
			audio: tracks.audio.map((track) => ({
				...track,
				elements: track.elements.map((element) => {
					const { buffer: _buffer, ...rest } = element;
					return rest;
				}),
			})),
		};
	}

	private serializeProject(project: TProject): SerializedProject {
		const duration =
			project.metadata.duration ??
			getProjectDurationFromScenes({ scenes: project.scenes });
		const scenes: SerializedScene[] = project.scenes.map((scene) => ({
			id: scene.id,
			name: scene.name,
			isMain: scene.isMain,
			tracks: this.stripAudioBuffers({ tracks: scene.tracks }),
			bookmarks: scene.bookmarks,
			createdAt: scene.createdAt.toISOString(),
			updatedAt: scene.updatedAt.toISOString(),
		}));
		return {
			metadata: {
				...project.metadata,
				duration,
				createdAt: project.metadata.createdAt.toISOString(),
				updatedAt: project.metadata.updatedAt.toISOString(),
			},
			scenes,
			currentSceneId: project.currentSceneId,
			settings: project.settings,
			customFonts: project.customFonts,
			aiEditHistory: project.aiEditHistory ?? [],
			version: project.version,
			timelineViewState: project.timelineViewState,
		};
	}

	async saveProject({ project }: { project: TProject }): Promise<void> {
		await localDriveRequest({
			operation: "project.put",
			payload: {
				projectId: project.metadata.id,
				project: this.serializeProject(project),
			},
		});
	}

	async loadProject({
		id,
	}: {
		id: string;
	}): Promise<{ project: TProject } | null> {
		await this.ensureBrowserDataMigrated();
		const serialized = await localDriveRequest<SerializedProject | null>({
			operation: "project.get",
			payload: { projectId: id },
		});
		return serialized ? { project: deserializeProject(serialized) } : null;
	}

	async loadAllProjects(): Promise<TProject[]> {
		await this.ensureBrowserDataMigrated();
		const serialized = await localDriveRequest<SerializedProject[]>({
			operation: "project.list",
		});
		return serialized
			.map(deserializeProject)
			.sort(
				(a, b) =>
					b.metadata.updatedAt.getTime() - a.metadata.updatedAt.getTime(),
			);
	}

	async loadAllProjectsMetadata(): Promise<TProjectMetadata[]> {
		await this.ensureBrowserDataMigrated();
		const projects = await localDriveRequest<SerializedProject[]>({
			operation: "project.list",
		});
		const metadata = projects
			.map((project) => readProjectMetadata(project))
			.filter((item): item is TProjectMetadata => item !== null);
		if (projects.length > 0 && metadata.length === 0) {
			throw new Error(
				"Project files were found on the drive but could not be read.",
			);
		}
		return metadata.sort(
			(a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
		);
	}

	async deleteProject({ id }: { id: string }): Promise<void> {
		await localDriveRequest({
			operation: "project.delete",
			payload: { projectId: id },
		});
	}

	async saveCommandHistory({
		history,
	}: {
		history: SerializedCommandHistory;
	}): Promise<void> {
		await localDriveRequest({
			operation: "history.put",
			payload: { projectId: history.projectId, history },
		});
	}

	async loadCommandHistory({ projectId }: { projectId: string }) {
		return localDriveRequest<SerializedCommandHistory | null>({
			operation: "history.get",
			payload: { projectId },
		});
	}

	async deleteCommandHistory({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		await localDriveRequest({
			operation: "history.delete",
			payload: { projectId },
		});
	}

	async saveMediaAsset({
		projectId,
		mediaAsset,
	}: {
		projectId: string;
		mediaAsset: MediaAsset;
	}): Promise<void> {
		const targetUrl = localMediaUrl({ projectId, id: mediaAsset.id });
		if (mediaAsset.file) {
			await uploadLocalMedia({
				projectId,
				id: mediaAsset.id,
				file: mediaAsset.file,
			});
		} else if (mediaAsset.sourcePath) {
			const registered = await localDriveRequest<LocalDriveMediaRecord>({
				operation: "media.registerPath",
				payload: {
					projectId,
					media: {
						...mediaAsset,
						fileName: mediaAsset.fileName ?? mediaAsset.name,
						mimeType: mediaAsset.mimeType ?? "application/octet-stream",
					},
					preserveLink: mediaAsset.storageKind === "linked",
				},
			});
			Object.assign(mediaAsset, registered);
		}

		const size = mediaAsset.file?.size ?? mediaAsset.size ?? 0;
		const lastModified =
			mediaAsset.file?.lastModified ?? mediaAsset.lastModified ?? Date.now();
		await localDriveRequest({
			operation: "media.put",
			payload: {
				projectId,
				media: {
					id: mediaAsset.id,
					name: mediaAsset.name,
					type: mediaAsset.type,
					size,
					lastModified,
					fileName:
						mediaAsset.file?.name ?? mediaAsset.fileName ?? mediaAsset.name,
					mimeType:
						mediaAsset.file?.type ??
						mediaAsset.mimeType ??
						"application/octet-stream",
					storageKind: mediaAsset.storageKind ?? "copied",
					sourcePath: mediaAsset.sourcePath ?? "",
					width: mediaAsset.width,
					height: mediaAsset.height,
					duration: mediaAsset.duration,
					fps: mediaAsset.fps,
					hasAudio: mediaAsset.hasAudio,
					thumbnailUrl: mediaAsset.thumbnailUrl,
					ephemeral: mediaAsset.ephemeral,
				},
			},
		});
		mediaAsset.url = targetUrl;
		mediaAsset.size = size;
		mediaAsset.lastModified = lastModified;
	}

	private hydrateMedia({
		projectId,
		record,
	}: {
		projectId: string;
		record: LocalDriveMediaRecord;
	}): MediaAsset {
		return { ...record, url: localMediaUrl({ projectId, id: record.id }) };
	}

	async loadMediaAsset({ projectId, id }: { projectId: string; id: string }) {
		const records = await localDriveRequest<LocalDriveMediaRecord[]>({
			operation: "media.list",
			payload: { projectId },
		});
		const record = records.find((item) => item.id === id);
		return record ? this.hydrateMedia({ projectId, record }) : null;
	}

	async loadAllMediaAssets({
		projectId,
	}: {
		projectId: string;
	}): Promise<MediaAsset[]> {
		const records = await localDriveRequest<LocalDriveMediaRecord[]>({
			operation: "media.list",
			payload: { projectId },
		});
		return records.map((record) => this.hydrateMedia({ projectId, record }));
	}

	async deleteMediaAsset({ projectId, id }: { projectId: string; id: string }) {
		await localDriveRequest({
			operation: "media.delete",
			payload: { projectId, id },
		});
	}

	async deleteProjectMedia({ projectId }: { projectId: string }) {
		await localDriveRequest({
			operation: "media.clear",
			payload: { projectId },
		});
	}

	async saveProjectFont({
		projectId,
		font,
	}: {
		projectId: string;
		font: ProjectFontAsset;
	}) {
		const storedPath = await uploadLocalFont({
			projectId,
			id: font.id,
			file: font.file,
		});
		const metadata: ProjectFontData = {
			id: font.id,
			family: font.family,
			fileName: font.fileName,
			mimeType: font.mimeType,
			size: font.file.size,
			lastModified: font.file.lastModified,
			createdAt: font.createdAt,
			sourceUrl: font.sourceUrl,
			repositoryPath: font.repositoryPath,
		};
		await localDriveRequest({
			operation: "font.put",
			payload: { projectId, font: metadata, storedPath },
		});
	}

	async loadProjectFont({ projectId, id }: { projectId: string; id: string }) {
		const fonts = await localDriveRequest<ProjectFontData[]>({
			operation: "font.list",
			payload: { projectId },
		});
		const font = fonts.find((item) => item.id === id);
		if (!font) return null;
		const file = await loadLocalFontFile({ projectId, font });
		return { ...font, file, url: localFontUrl({ projectId, id }) };
	}

	async loadAllProjectFonts({ projectId }: { projectId: string }) {
		const fonts = await localDriveRequest<ProjectFontData[]>({
			operation: "font.list",
			payload: { projectId },
		});
		return Promise.all(
			fonts.map(
				async (font): Promise<ProjectFontAsset> => ({
					...font,
					file: await loadLocalFontFile({ projectId, font }),
					url: localFontUrl({ projectId, id: font.id }),
				}),
			),
		);
	}

	async deleteProjectFont({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}) {
		await localDriveRequest({
			operation: "font.delete",
			payload: { projectId, id },
		});
	}

	async deleteProjectFonts({ projectId }: { projectId: string }) {
		await localDriveRequest({
			operation: "font.clear",
			payload: { projectId },
		});
	}

	async clearAllData(): Promise<void> {
		await localDriveRequest({ operation: "all.clear" });
	}

	async getStorageInfo() {
		const projects = await localDriveRequest<SerializedProject[]>({
			operation: "project.list",
		});
		return {
			projects: projects.length,
			isOPFSSupported: false,
			isIndexedDBSupported: typeof indexedDB !== "undefined",
		};
	}

	async getProjectStorageInfo({ projectId }: { projectId: string }) {
		const media = await localDriveRequest<LocalDriveMediaRecord[]>({
			operation: "media.list",
			payload: { projectId },
		});
		return { mediaItems: media.length };
	}

	async loadSavedSounds(): Promise<SavedSoundsData> {
		return (
			(await localDriveRequest<SavedSoundsData | null>({
				operation: "sounds.get",
			})) ?? {
				sounds: [],
				lastModified: new Date().toISOString(),
			}
		);
	}

	async saveSoundEffect({
		soundEffect,
	}: {
		soundEffect: SoundEffect;
	}): Promise<void> {
		const currentData = await this.loadSavedSounds();
		if (currentData.sounds.some((sound) => sound.id === soundEffect.id)) return;
		const savedSound: SavedSound = {
			id: soundEffect.id,
			name: soundEffect.name,
			username: soundEffect.username,
			previewUrl: soundEffect.previewUrl,
			downloadUrl: soundEffect.downloadUrl,
			duration: soundEffect.duration,
			tags: soundEffect.tags,
			license: soundEffect.license,
			savedAt: new Date().toISOString(),
		};
		await localDriveRequest({
			operation: "sounds.put",
			payload: {
				sounds: {
					sounds: [...currentData.sounds, savedSound],
					lastModified: new Date().toISOString(),
				},
			},
		});
	}

	async removeSavedSound({ soundId }: { soundId: number }) {
		const currentData = await this.loadSavedSounds();
		await localDriveRequest({
			operation: "sounds.put",
			payload: {
				sounds: {
					sounds: currentData.sounds.filter((sound) => sound.id !== soundId),
					lastModified: new Date().toISOString(),
				},
			},
		});
	}

	async isSoundSaved({ soundId }: { soundId: number }) {
		return (await this.loadSavedSounds()).sounds.some(
			(sound) => sound.id === soundId,
		);
	}

	async clearSavedSounds() {
		await localDriveRequest({ operation: "sounds.delete" });
	}

	isOPFSSupported(): boolean {
		return false;
	}

	isIndexedDBSupported(): boolean {
		return typeof indexedDB !== "undefined";
	}

	isFullySupported(): boolean {
		return true;
	}
}

export const storageService = new StorageService();
