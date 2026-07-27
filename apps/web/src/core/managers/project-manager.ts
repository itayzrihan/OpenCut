import type { EditorCore } from "@/core";
import type {
	TProject,
	TProjectMetadata,
	TProjectSortKey,
	TProjectSortOption,
	TProjectSettings,
	TTimelineViewState,
} from "@/project/types";
import type { ExportOptions, ExportResult, ExportState } from "@/export";
import { storageService } from "@/services/storage/service";
import { toast } from "sonner";
import { generateUUID } from "@/utils/id";
import { UpdateProjectSettingsCommand } from "@/commands/project";
import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import { DEFAULT_CANVAS_SIZE } from "@/canvas/sizes";
import { DEFAULT_FPS } from "@/fps/defaults";
import {
	buildDefaultScene,
	getProjectDurationFromScenes,
} from "@/timeline/scenes";
import { buildScene } from "@/services/renderer/scene-builder";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import {
	CURRENT_PROJECT_VERSION,
	migrations,
	runStorageMigrations,
	type MigrationProgress,
	type StorageMigrationFailure,
	type StorageMigrationResult,
} from "@/services/storage/migrations";
import { loadFonts } from "@/fonts/google-fonts";
import {
	buildUniqueFontFamily,
	getSupportedFontMimeType,
	isSupportedFontFile,
	loadProjectFont,
} from "@/fonts/custom-fonts";
import { copyFontToRepository } from "@/fonts/repository-fonts";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";
import { DEFAULTS } from "@/timeline/defaults";
import { getElementFontFamilies } from "@/timeline/element-utils";
import { getRaisedProjectFpsForImportedMedia } from "@/fps/utils";
import type { MediaAsset } from "@/media/types";
import type { ProjectFont, ProjectFontAsset } from "@/fonts/types";
import {
	createProjectArchive,
	importProjectArchive as importProjectArchiveFile,
	type ImportProjectArchiveResult,
} from "@/project/archive/project-archive";

type RuntimeProjectFont = ProjectFont | ProjectFontAsset;

export interface MigrationState {
	isMigrating: boolean;
	fromVersion: number | null;
	toVersion: number | null;
	projectName: string | null;
}

const PROJECT_SORT_OPTIONS: Record<
	TProjectSortOption,
	{ key: TProjectSortKey; order: "asc" | "desc" }
> = {
	"createdAt-asc": { key: "createdAt", order: "asc" },
	"createdAt-desc": { key: "createdAt", order: "desc" },
	"updatedAt-asc": { key: "updatedAt", order: "asc" },
	"updatedAt-desc": { key: "updatedAt", order: "desc" },
	"name-asc": { key: "name", order: "asc" },
	"name-desc": { key: "name", order: "desc" },
	"duration-asc": { key: "duration", order: "asc" },
	"duration-desc": { key: "duration", order: "desc" },
};

export function filterAndSortProjectMetadata({
	projects,
	searchQuery,
	sortOption,
}: {
	projects: TProjectMetadata[];
	searchQuery: string;
	sortOption: TProjectSortOption;
}): TProjectMetadata[] {
	const filteredProjects = projects.filter((project) =>
		project.name.toLowerCase().includes(searchQuery.toLowerCase()),
	);

	const { key, order } = PROJECT_SORT_OPTIONS[sortOption];

	return [...filteredProjects].sort((a, b) => {
		const aValue = a[key];
		const bValue = b[key];

		if (order === "asc") {
			if (aValue < bValue) return -1;
			if (aValue > bValue) return 1;
			return 0;
		}
		if (aValue > bValue) return -1;
		if (aValue < bValue) return 1;
		return 0;
	});
}

export class ProjectManager {
	private active: TProject | null = null;
	private savedProjects: TProjectMetadata[] = [];
	private isLoading = true;
	private isInitialized = false;
	private loadError: string | null = null;
	private migrationFailures: StorageMigrationFailure[] = [];
	private invalidProjectIds = new Set<string>();
	private storageMigrationPromise: Promise<StorageMigrationResult> | null =
		null;
	private listeners = new Set<() => void>();
	private migrationState: MigrationState = {
		isMigrating: false,
		fromVersion: null,
		toVersion: null,
		projectName: null,
	};
	private exportState: ExportState = {
		isExporting: false,
		progress: 0,
		result: null,
	};
	private exportCancelRequested = false;

	constructor(private editor: EditorCore) {}

	private async ensureStorageMigrations(): Promise<StorageMigrationResult> {
		if (!this.storageMigrationPromise) {
			const onProgress = (progress: MigrationProgress) => {
				this.migrationState = progress;
				this.notify();
			};
			this.storageMigrationPromise = (async () => {
				const browserResult = await runStorageMigrations({
					migrations,
					onProgress,
				});
				await storageService.ensureBrowserDataMigrated();
				const driveResult = await runStorageMigrations({
					migrations,
					onProgress,
					dependencies: storageService.createDriveMigrationDependencies(),
				});
				return {
					migratedCount:
						browserResult.migratedCount + driveResult.migratedCount,
					failures: [...browserResult.failures, ...driveResult.failures],
				};
			})();
		}

		const migrationPromise = this.storageMigrationPromise;
		try {
			return await migrationPromise;
		} catch (error) {
			// A failed promise must not poison future retries for the lifetime of the
			// editor singleton. The projects page exposes an explicit retry action.
			if (this.storageMigrationPromise === migrationPromise) {
				this.storageMigrationPromise = null;
			}
			throw error;
		}
	}

	async createNewProject({ name }: { name: string }): Promise<string> {
		const mainScene = buildDefaultScene({ name: "Main scene", isMain: true });
		const newProject: TProject = {
			metadata: {
				id: generateUUID(),
				name,
				duration: getProjectDurationFromScenes({ scenes: [mainScene] }),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			scenes: [mainScene],
			currentSceneId: mainScene.id,
			settings: {
				fps: DEFAULT_FPS,
				canvasSize: DEFAULT_CANVAS_SIZE,
				canvasSizeMode: "preset",
				lastCustomCanvasSize: null,
				originalCanvasSize: null,
				background: {
					type: "color",
					color: DEFAULT_BACKGROUND_COLOR,
				},
			},
			customFonts: [],
			aiEditHistory: [],
			version: CURRENT_PROJECT_VERSION,
		};

		this.active = newProject;
		this.notify();

		this.editor.media.clearAllAssets();
		this.editor.scenes.initializeScenes({
			scenes: newProject.scenes,
			currentSceneId: newProject.currentSceneId,
		});

		try {
			await storageService.saveProject({ project: newProject });
			await this.editor.command.initializeEmptyHistory({
				projectId: newProject.metadata.id,
			});
			this.updateMetadata(newProject);

			return newProject.metadata.id;
		} catch (error) {
			toast.error("Failed to save new project");
			throw error;
		}
	}

	async loadProject({ id }: { id: string }): Promise<void> {
		if (this.active && this.active.metadata.id !== id) {
			// Route changes can switch projects without going through the explicit Exit
			// action. Persist the current project before clearing any in-memory state.
			await this.editor.save.flush();
		}

		this.isLoading = true;
		this.notify();

		this.editor.save.pause();
		try {
			const migrationResult = await this.ensureStorageMigrations();
			const migrationFailure = migrationResult.failures.find(
				(failure) => failure.projectId === id,
			);
			if (migrationFailure) {
				throw new Error(
					`This project could not be upgraded safely: ${migrationFailure.message}. Its original stored record was preserved in recovery storage.`,
				);
			}
			this.editor.media.clearAllAssets();
			this.editor.scenes.clearScenes();

			const result = await storageService.loadProject({ id });
			if (!result) {
				throw new Error(`Project with id ${id} not found`);
			}

			const project = result.project;
			const projectFonts = await this.hydrateProjectFonts({ project });
			const projectWithFonts: TProject = {
				...project,
				customFonts: projectFonts.map((font) =>
					this.getProjectFontMetadata({ font }),
				),
			};

			this.active = projectWithFonts;
			this.notify();

			if (projectWithFonts.scenes && projectWithFonts.scenes.length > 0) {
				this.editor.scenes.initializeScenes({
					scenes: projectWithFonts.scenes,
					currentSceneId: projectWithFonts.currentSceneId,
				});
			}

			await this.editor.media.loadProjectMedia({ projectId: id });
			await this.editor.command.loadHistory({ projectId: id });

			const customFontFamilies = new Set(
				projectWithFonts.customFonts?.map((font) => font.family) ?? [],
			);
			await loadFonts({
				families: [
					...new Set(
						(projectWithFonts.scenes ?? []).flatMap((scene) =>
							getElementFontFamilies({ tracks: scene.tracks }),
						),
					),
				].filter((family) => !customFontFamilies.has(family)),
			});

			if (!projectWithFonts.metadata.thumbnail) {
				try {
					const didUpdateThumbnail = await this.updateThumbnailFromTimeline();
					if (didUpdateThumbnail) {
						await this.saveCurrentProject();
					}
				} catch (error) {
					console.error("Failed to generate project thumbnail:", error);
				}
			}
		} catch (error) {
			console.error("Failed to load project:", error);
			throw error;
		} finally {
			this.isLoading = false;
			this.notify();
			this.editor.save.resume();
		}
	}

	async saveCurrentProject(): Promise<void> {
		if (!this.active) return;

		const projectAtSaveStart = this.active;
		try {
			const scenes = this.editor.scenes.getScenes();
			const updatedProject = {
				...projectAtSaveStart,
				scenes,
				metadata: {
					...projectAtSaveStart.metadata,
					duration: getProjectDurationFromScenes({ scenes }),
					updatedAt: new Date(),
				},
			};

			await storageService.saveProject({ project: updatedProject });
			// Do not replace newer settings or metadata that were applied while the
			// IndexedDB write was in flight. SaveManager will persist those changes in
			// the next queued write.
			if (this.active === projectAtSaveStart) {
				this.active = updatedProject;
			}
			this.updateMetadata(updatedProject);
		} catch (error) {
			console.error("Failed to save project:", error);
			throw error;
		}
	}

	async export({ options }: { options: ExportOptions }): Promise<ExportResult> {
		this.exportCancelRequested = false;
		this.exportState = {
			isExporting: true,
			progress: 0,
			result: null,
			options,
		};
		this.notify();

		let result: ExportResult;
		try {
			result = await this.editor.renderer.exportProject({
				options,
				onProgress: ({ progress }) => {
					this.exportState = { ...this.exportState, progress };
					this.notify();
				},
				onCancel: () => this.exportCancelRequested,
			});
		} catch (error) {
			result = {
				success: false,
				error: error instanceof Error ? error.message : "Project export failed",
			};
		}

		this.exportState = {
			isExporting: false,
			progress: this.exportState.progress,
			result,
			options,
		};
		this.notify();

		return result;
	}

	async exportProjectArchive(): Promise<Blob> {
		if (!this.active) {
			throw new Error("No active project");
		}

		await this.editor.save.flush();
		await this.editor.command.flushHistory();

		const project = this.getActive();
		const projectId = project.metadata.id;
		const [projectFonts, commandHistory] = await Promise.all([
			storageService.loadAllProjectFonts({ projectId }),
			storageService.loadCommandHistory({ projectId }),
		]);

		return createProjectArchive({
			project,
			mediaAssets: this.editor.media.getAssets(),
			projectFonts,
			commandHistory,
		});
	}

	async importProjectArchive({
		file,
	}: {
		file: File;
	}): Promise<ImportProjectArchiveResult> {
		const result = await importProjectArchiveFile({ file });
		const loaded = await storageService.loadProject({ id: result.projectId });
		if (loaded?.project) {
			this.updateMetadata(loaded.project);
		}
		return result;
	}

	cancelExport(): void {
		this.exportCancelRequested = true;
	}

	clearExportState(): void {
		this.exportState = { isExporting: false, progress: 0, result: null };
		this.notify();
	}

	getExportState(): ExportState {
		return this.exportState;
	}

	async loadAllProjects(): Promise<void> {
		const shouldRetryFailedMigrations = this.migrationFailures.length > 0;
		this.isLoading = true;
		this.loadError = null;
		this.migrationFailures = [];
		if (shouldRetryFailedMigrations) {
			this.storageMigrationPromise = null;
		}
		this.notify();

		try {
			const migrationResult = await this.ensureStorageMigrations();
			this.migrationFailures = migrationResult.failures;
			const metadata = await storageService.loadAllProjectsMetadata();
			this.savedProjects = metadata;
		} catch (error) {
			console.error("Failed to load project library:", error);
			const message =
				error instanceof Error
					? error.message
					: typeof error === "string"
						? error
						: "An unknown project storage error occurred";
			this.loadError =
				message.trim() || "An unknown project storage error occurred";
		} finally {
			this.isLoading = false;
			this.isInitialized = true;
			this.notify();
		}
	}

	async deleteProjects({ ids }: { ids: string[] }): Promise<void> {
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 0) return;

		try {
			await Promise.all(
				uniqueIds.map((id) =>
					Promise.all([
						storageService.deleteProjectMedia({ projectId: id }),
						storageService.deleteProjectFonts({ projectId: id }),
						storageService.deleteProject({ id }),
					]),
				),
			);

			const idSet = new Set(uniqueIds);
			this.savedProjects = this.savedProjects.filter(
				(project) => !idSet.has(project.id),
			);

			const shouldClearActive =
				this.active && idSet.has(this.active.metadata.id);

			if (shouldClearActive) {
				this.active = null;
				this.editor.media.clearAllAssets();
				this.editor.scenes.clearScenes();
				this.editor.command.clearLoadedProject();
			}

			this.notify();
		} catch (error) {
			console.error("Failed to delete projects:", error);
			throw error;
		}
	}

	async importCustomFonts({
		files,
	}: {
		files: File[];
	}): Promise<ProjectFont[]> {
		if (!this.active) return [];

		const projectId = this.active.metadata.id;
		const existingFonts = this.active.customFonts ?? [];
		const importedFonts: ProjectFont[] = [];
		const existingFamilies = new Set([
			...existingFonts.map((font) => font.family),
			...SYSTEM_FONTS,
		]);

		for (const file of files) {
			if (!isSupportedFontFile({ file })) {
				toast.error(`Unsupported font type: ${file.name}`);
				continue;
			}

			const storageCheck = await storageService.canStoreFile({
				size: file.size,
			});
			if (!storageCheck.canStore) {
				toast.error(`Not enough browser storage for ${file.name}`);
				continue;
			}

			const fontId = generateUUID();
			const family = buildUniqueFontFamily({
				fileName: file.name,
				existingFamilies,
			});
			const mimeType = getSupportedFontMimeType({ file }) ?? file.type;
			const createdAt = new Date().toISOString();
			const objectUrl = URL.createObjectURL(file);
			const baseFont: ProjectFontAsset = {
				id: fontId,
				family,
				fileName: file.name,
				mimeType,
				size: file.size,
				lastModified: file.lastModified,
				createdAt,
				file,
				url: objectUrl,
			};

			try {
				await loadProjectFont({ font: baseFont });

				const repositoryCopy = await copyFontToRepository({
					projectId,
					fontId,
					file,
				});
				const font: ProjectFontAsset = {
					...baseFont,
					sourceUrl: repositoryCopy?.sourceUrl,
					repositoryPath: repositoryCopy?.repositoryPath,
				};

				await storageService.saveProjectFont({ projectId, font });

				importedFonts.push(this.getProjectFontMetadata({ font }));
				existingFamilies.add(family);
			} catch (error) {
				URL.revokeObjectURL(objectUrl);
				console.error("Failed to import font:", error);
				toast.error(`Failed to import ${file.name}`, {
					description:
						error instanceof Error
							? error.message
							: "The font could not be loaded",
				});
			}
		}

		if (importedFonts.length === 0) return [];

		const updatedProject: TProject = {
			...this.active,
			customFonts: [...existingFonts, ...importedFonts],
			metadata: {
				...this.active.metadata,
				updatedAt: new Date(),
			},
		};

		this.active = updatedProject;
		this.notify();
		this.updateMetadata(updatedProject);
		await storageService.saveProject({ project: updatedProject });

		return importedFonts;
	}

	closeProject(): void {
		if (this.editor.save.getIsDirty()) {
			throw new Error("Cannot close a project while it has unsaved changes");
		}

		this.active = null;
		this.notify();

		this.editor.media.clearAllAssets();
		this.editor.scenes.clearScenes();
		this.editor.command.clearLoadedProject();
		this.editor.save.discardPending();
	}

	async renameProject({
		id,
		name,
	}: {
		id: string;
		name: string;
	}): Promise<void> {
		try {
			const result = await storageService.loadProject({ id });
			if (!result) {
				toast.error("Project not found", {
					description: "Please try again",
				});
				return;
			}

			const updatedProject: TProject = {
				...result.project,
				metadata: {
					...result.project.metadata,
					name,
					updatedAt: new Date(),
				},
			};

			await storageService.saveProject({ project: updatedProject });

			if (this.active?.metadata.id === id) {
				this.active = updatedProject;
				this.notify();
			}

			this.updateMetadata(updatedProject);
		} catch (error) {
			console.error("Failed to rename project:", error);
			toast.error("Failed to rename project", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
		}
	}

	async duplicateProjects({ ids }: { ids: string[] }): Promise<string[]> {
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 0) return [];

		try {
			const getDuplicateBaseName = ({ name }: { name: string }) => {
				const match = name.match(/^\((\d+)\)\s+(.+)$/);
				const number = match ? Number.parseInt(match[1], 10) : null;
				const baseName = match ? match[2] : name;
				return { baseName, number };
			};

			const loadResults = await Promise.all(
				uniqueIds.map(async (projectId) => {
					const result = await storageService.loadProject({ id: projectId });
					return { projectId, project: result?.project ?? null };
				}),
			);

			const missingProjectIds = loadResults
				.filter((result) => !result.project)
				.map((result) => result.projectId);

			if (missingProjectIds.length > 0) {
				toast.error(
					missingProjectIds.length === 1
						? "Project not found"
						: "Projects not found",
					{
						description:
							missingProjectIds.length === 1
								? "Please try again"
								: "Some projects could not be found",
					},
				);
				throw new Error(`Projects not found: ${missingProjectIds.join(", ")}`);
			}

			const projectsToDuplicate = loadResults.flatMap((result) =>
				result.project ? [result.project] : [],
			);

			const maxNumberByBaseName = new Map<string, number>();

			for (const project of this.savedProjects) {
				const { baseName, number } = getDuplicateBaseName({
					name: project.name,
				});

				if (number === null) continue;

				const currentMax = maxNumberByBaseName.get(baseName);
				if (currentMax === undefined || number > currentMax) {
					maxNumberByBaseName.set(baseName, number);
				}
			}

			const nextNumberByBaseName = new Map<string, number>();
			for (const [baseName, maxNumber] of maxNumberByBaseName) {
				nextNumberByBaseName.set(baseName, maxNumber + 1);
			}

			const duplicationPlans = projectsToDuplicate.map((project) => {
				const { baseName } = getDuplicateBaseName({
					name: project.metadata.name,
				});
				const nextNumber = nextNumberByBaseName.get(baseName) ?? 1;
				nextNumberByBaseName.set(baseName, nextNumber + 1);

				const newProjectId = generateUUID();
				const newProject: TProject = {
					...project,
					metadata: {
						...project.metadata,
						id: newProjectId,
						name: `(${nextNumber}) ${baseName}`,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				};

				return {
					newProjectId,
					newProject,
					sourceProjectId: project.metadata.id,
				};
			});

			await Promise.all(
				duplicationPlans.map(({ newProject }) =>
					storageService.saveProject({ project: newProject }),
				),
			);

			await Promise.all(
				duplicationPlans.map(async ({ sourceProjectId, newProjectId }) => {
					const sourceMediaAssets = await storageService.loadAllMediaAssets({
						projectId: sourceProjectId,
					});
					const sourceProjectFonts = await storageService.loadAllProjectFonts({
						projectId: sourceProjectId,
					});

					await Promise.all([
						...sourceMediaAssets.map((mediaAsset) =>
							storageService.saveMediaAsset({
								projectId: newProjectId,
								mediaAsset,
							}),
						),
						...sourceProjectFonts.map((font) =>
							storageService.saveProjectFont({
								projectId: newProjectId,
								font,
							}),
						),
					]);
				}),
			);

			for (const { newProject } of duplicationPlans) {
				this.updateMetadata(newProject);
			}

			return duplicationPlans.map((plan) => plan.newProjectId);
		} catch (error) {
			console.error("Failed to duplicate projects:", error);
			toast.error("Failed to duplicate projects", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
			throw error;
		}
	}

	async updateSettings({
		settings,
		pushHistory = true,
	}: {
		settings: Partial<TProjectSettings>;
		pushHistory?: boolean;
	}): Promise<void> {
		if (!this.active) return;

		const command = new UpdateProjectSettingsCommand(settings);
		if (pushHistory) {
			this.editor.command.execute({ command });
			return;
		}

		command.execute();
	}

	ratchetFpsForImportedMedia({
		importedAssets,
	}: {
		importedAssets: Array<Pick<MediaAsset, "type" | "fps">>;
	}): import("opencut-wasm").FrameRate | null {
		if (!this.active) return null;

		const nextFps = getRaisedProjectFpsForImportedMedia({
			currentFps: this.active.settings.fps,
			importedAssets,
		});
		if (nextFps === null) return null;

		new UpdateProjectSettingsCommand({ fps: nextFps }).execute();
		return nextFps;
	}

	async updateThumbnail({ thumbnail }: { thumbnail: string }): Promise<void> {
		if (!this.active) return;

		const updatedProject: TProject = {
			...this.active,
			metadata: { ...this.active.metadata, thumbnail, updatedAt: new Date() },
		};
		this.active = updatedProject;
		this.notify();
		this.updateMetadata(updatedProject);
		this.editor.save.markDirty();
	}

	async prepareExit(): Promise<void> {
		if (!this.active) return;

		try {
			await this.updateThumbnailFromTimeline();
		} catch (error) {
			console.error("Failed to generate project thumbnail on exit:", error);
		}

		// The project write and command-history write are independent. Start both so
		// one failure cannot prevent the other from getting its final flush.
		const results = await Promise.allSettled([
			this.editor.save.flush(),
			this.editor.command.flushHistory(),
		]);
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length === 1) {
			throw failures[0];
		}
		if (failures.length > 1) {
			throw new AggregateError(
				failures,
				"Failed to persist the project on exit",
			);
		}
	}

	getFilteredAndSortedProjects({
		searchQuery,
		sortOption,
	}: {
		searchQuery: string;
		sortOption: TProjectSortOption;
	}): TProjectMetadata[] {
		return filterAndSortProjectMetadata({
			projects: this.savedProjects,
			searchQuery,
			sortOption,
		});
	}

	isInvalidProjectId({ id }: { id: string }): boolean {
		return this.invalidProjectIds.has(id);
	}

	markProjectIdAsInvalid({ id }: { id: string }): void {
		this.invalidProjectIds.add(id);
		this.notify();
	}

	clearInvalidProjectIds(): void {
		this.invalidProjectIds.clear();
		this.notify();
	}

	getActive(): TProject {
		if (!this.active) {
			throw new Error("No active project");
		}
		return this.active;
	}

	/**
	 * for agents:
	 * in most cases, the project is guaranteed to be active, in which getActive() should be used instead.
	 * for very rare cases, this function may be used.
	 */
	getActiveOrNull(): TProject | null {
		return this.active;
	}

	getTimelineViewState(): TTimelineViewState {
		return this.active?.timelineViewState ?? DEFAULTS.timeline.viewState;
	}

	setTimelineViewState({ viewState }: { viewState: TTimelineViewState }): void {
		if (!this.active) return;
		this.active = {
			...this.active,
			timelineViewState: viewState ?? undefined,
		};
		this.editor.save.markDirty();
		this.notify();
	}

	getSavedProjects(): TProjectMetadata[] {
		return this.savedProjects;
	}

	getIsLoading(): boolean {
		return this.isLoading;
	}

	getIsInitialized(): boolean {
		return this.isInitialized;
	}

	getLoadError(): string | null {
		return this.loadError;
	}

	getMigrationFailures(): StorageMigrationFailure[] {
		return this.migrationFailures;
	}

	getMigrationState(): MigrationState {
		return this.migrationState;
	}

	setActiveProject({ project }: { project: TProject }): void {
		this.active = project;
		this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async hydrateProjectFonts({
		project,
	}: {
		project: TProject;
	}): Promise<RuntimeProjectFont[]> {
		let storedFonts: ProjectFontAsset[] = [];
		try {
			storedFonts = await storageService.loadAllProjectFonts({
				projectId: project.metadata.id,
			});
		} catch (error) {
			console.error("Failed to load project fonts:", error);
		}

		const storedById = new Map(storedFonts.map((font) => [font.id, font]));
		const runtimeFonts: RuntimeProjectFont[] = [];
		const seen = new Set<string>();

		for (const font of project.customFonts ?? []) {
			const stored = storedById.get(font.id);
			if (stored) {
				runtimeFonts.push({
					...stored,
					...font,
					file: stored.file,
					url: stored.url,
				});
				seen.add(font.id);
				continue;
			}

			const restored = await this.restoreProjectFontFromRepository({
				projectId: project.metadata.id,
				font,
			});
			runtimeFonts.push(restored ?? font);
			seen.add(font.id);
		}

		for (const font of storedFonts) {
			if (!seen.has(font.id)) {
				runtimeFonts.push(font);
			}
		}

		await Promise.all(
			runtimeFonts.map(async (font) => {
				try {
					await loadProjectFont({ font });
				} catch (error) {
					console.warn(`Failed to load project font "${font.family}":`, error);
				}
			}),
		);

		return runtimeFonts;
	}

	private async restoreProjectFontFromRepository({
		projectId,
		font,
	}: {
		projectId: string;
		font: ProjectFont;
	}): Promise<ProjectFontAsset | null> {
		if (!font.sourceUrl) return null;

		try {
			const response = await fetch(font.sourceUrl);
			if (!response.ok) return null;

			const blob = await response.blob();
			const file = new File([blob], font.fileName, {
				type: font.mimeType,
				lastModified: font.lastModified,
			});
			const asset: ProjectFontAsset = {
				...font,
				file,
				url: URL.createObjectURL(file),
			};
			await storageService.saveProjectFont({ projectId, font: asset });
			return asset;
		} catch (error) {
			console.warn(
				`Could not restore project font "${font.family}" from repository assets:`,
				error,
			);
			return null;
		}
	}

	private getProjectFontMetadata({
		font,
	}: {
		font: RuntimeProjectFont;
	}): ProjectFont {
		return {
			id: font.id,
			family: font.family,
			fileName: font.fileName,
			mimeType: font.mimeType,
			size: font.size,
			lastModified: font.lastModified,
			createdAt: font.createdAt,
			sourceUrl: font.sourceUrl,
			repositoryPath: font.repositoryPath,
		};
	}

	private async updateThumbnailFromTimeline(): Promise<boolean> {
		if (!this.active) return false;

		const tracks = this.editor.scenes.getActiveScene().tracks;
		const mediaAssets = this.editor.media.getAssets();
		const duration = this.editor.timeline.getTotalDuration();
		const { canvasSize, background } = this.active.settings;

		const scene = buildScene({
			tracks,
			mediaAssets,
			duration: duration || 1,
			canvasSize,
			background,
		});

		const renderer = new CanvasRenderer({
			width: canvasSize.width,
			height: canvasSize.height,
			fps: this.active.settings.fps,
		});

		const tempCanvas = document.createElement("canvas");
		tempCanvas.width = canvasSize.width;
		tempCanvas.height = canvasSize.height;

		await renderer.renderToCanvas({
			node: scene,
			time: 0,
			targetCanvas: tempCanvas,
		});

		const thumbnailDataUrl = tempCanvas.toDataURL("image/png");

		await this.updateThumbnail({ thumbnail: thumbnailDataUrl });
		return true;
	}

	private updateMetadata(project: TProject): void {
		const index = this.savedProjects.findIndex(
			(p) => p.id === project.metadata.id,
		);

		if (index !== -1) {
			this.savedProjects = this.savedProjects.with(index, project.metadata);
		} else {
			this.savedProjects = [project.metadata, ...this.savedProjects];
		}

		this.notify();
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
