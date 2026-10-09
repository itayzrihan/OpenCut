import type { EditorCore } from "@/core";
import type { Bookmark, SceneTracks, TScene } from "@/timeline";
import { storageService } from "@/services/storage/service";
import {
	getMainScene,
	ensureMainScene,
	findCurrentScene,
} from "@/timeline/scenes";
import {
	getBookmarkAtTime,
	getFrameTime,
	isBookmarkAtTime,
} from "@/timeline/bookmarks/index";
import { generateUUID } from "@/utils/id";
import { restoreParallaxSceneMetadataForScenes } from "@/parallax-story-teller/model";
import type { MediaTime } from "@/wasm";

export class ScenesManager {
	private active: TScene | null = null;
	private list: TScene[] = [];
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	async createScene({
		name,
		isMain = false,
	}: {
		name: string;
		isMain: boolean;
	}): Promise<string> {
		if (!this.editor.project.getActive()) {
			throw new Error("No active project");
		}

		const sceneId = generateUUID();
		this.editor.command.editClassicScene({
			type: "create",
			sceneId,
			mainTrackId: generateUUID(),
			name,
			isMain,
		});
		return sceneId;
	}

	async deleteScene({ sceneId }: { sceneId: string }): Promise<void> {
		this.editor.command.editClassicScene({ type: "delete", sceneId });
	}

	async renameScene({
		sceneId,
		name,
	}: {
		sceneId: string;
		name: string;
	}): Promise<void> {
		if (!this.editor.project.getActive()) {
			throw new Error("No active project");
		}

		this.editor.command.editClassicScene({ type: "rename", sceneId, name });
	}

	async switchToScene({ sceneId }: { sceneId: string }): Promise<void> {
		this.editor.command.editClassicScene({ type: "select", sceneId });
	}

	async toggleBookmark({ time }: { time: MediaTime }): Promise<void> {
		this.editor.command.editClassicBookmarks({
			sceneId: this.getActiveScene().id,
			change: { type: "toggle", time },
		});
	}

	isBookmarked({ time }: { time: MediaTime }): boolean {
		const activeScene = this.getActiveScene();
		const activeProject = this.editor.project.getActive();

		if (!activeScene || !this.active || !activeProject) return false;

		const frameTime = getFrameTime({
			time,
			fps: activeProject.settings.fps,
		});

		return isBookmarkAtTime({ bookmarks: activeScene.bookmarks, frameTime });
	}

	async removeBookmark({ time }: { time: MediaTime }): Promise<void> {
		this.editor.command.editClassicBookmarks({
			sceneId: this.getActiveScene().id,
			change: { type: "remove", time },
		});
	}

	async updateBookmark({
		time,
		updates,
	}: {
		time: MediaTime;
		updates: Partial<Omit<Bookmark, "time">>;
	}): Promise<void> {
		const fields = ["note", "color", "duration", "groupId"] as const;
		const clear = fields.filter(
			(key) => Object.hasOwn(updates, key) && updates[key] === undefined,
		);
		this.editor.command.editClassicBookmarks({
			sceneId: this.getActiveScene().id,
			change: { type: "update", time, updates: { ...updates, clear } },
		});
	}

	async moveBookmark({
		fromTime,
		toTime,
	}: {
		fromTime: MediaTime;
		toTime: MediaTime;
	}): Promise<void> {
		this.editor.command.editClassicBookmarks({
			sceneId: this.getActiveScene().id,
			change: { type: "move", fromTime, toTime },
		});
	}

	getBookmarkAtTime({ time }: { time: MediaTime }) {
		const activeScene = this.active;
		const activeProject = this.editor.project.getActive();

		if (!activeScene || !activeProject) return null;

		const frameTime = getFrameTime({
			time,
			fps: activeProject.settings.fps,
		});

		return getBookmarkAtTime({
			bookmarks: activeScene.bookmarks,
			frameTime,
		});
	}

	async loadProjectScenes({ projectId }: { projectId: string }): Promise<void> {
		try {
			const result = await storageService.loadProject({ id: projectId });
			if (result?.project.scenes) {
				const ensuredScenes = result.project.scenes ?? [];
				const currentScene = findCurrentScene({
					scenes: ensuredScenes,
					currentSceneId: result.project.currentSceneId,
				});

				this.list = ensuredScenes;
				this.active = currentScene;
				this.notify();
			}
		} catch (error) {
			console.error("Failed to load project scenes:", error);
			this.list = [];
			this.active = null;
			this.notify();
		}
	}

	initializeScenes({
		scenes,
		currentSceneId,
	}: {
		scenes: TScene[];
		currentSceneId?: string;
	}): void {
		const ensuredScenes = ensureMainScene({ scenes });
		const normalizedScenes = restoreParallaxSceneMetadataForScenes({
			scenes: ensuredScenes,
			cameraCanvasSize: this.editor.project.getActive()?.settings.canvasSize,
		});
		const currentScene = currentSceneId
			? normalizedScenes.find((s) => s.id === currentSceneId)
			: null;

		const fallbackScene = getMainScene({ scenes: normalizedScenes });

		const hasAddedMainScene = normalizedScenes.length > scenes.length;
		const hasRestoredParallaxMetadata = normalizedScenes.some(
			(scene, index) => scene !== ensuredScenes[index],
		);
		if (hasAddedMainScene || hasRestoredParallaxMetadata) {
			const activeProject = this.editor.project.getActive();

			if (activeProject) {
				const updatedProject = {
					...activeProject,
					scenes: normalizedScenes,
					metadata: {
						...activeProject.metadata,
						updatedAt: new Date(),
					},
				};

				this.editor.project.setActiveProject({ project: updatedProject });
				this.editor.save.markDirty({ force: true });
			}
		}
		this.list = normalizedScenes;
		this.active = currentScene || fallbackScene;
		this.notify();
	}

	clearScenes(): void {
		this.list = [];
		this.active = null;
		this.notify();
	}

	getActiveScene(): TScene {
		if (!this.active) {
			throw new Error("No active scene.");
		}
		return this.active;
	}

	getActiveSceneOrNull(): TScene | null {
		return this.active;
	}

	getScenes(): TScene[] {
		return this.list;
	}

	setScenes({
		scenes,
		activeSceneId,
	}: {
		scenes: TScene[];
		activeSceneId?: string;
	}): void {
		const normalizedScenes = restoreParallaxSceneMetadataForScenes({
			scenes,
			cameraCanvasSize: this.editor.project.getActive()?.settings.canvasSize,
		});
		const nextActiveSceneId = activeSceneId ?? this.active?.id ?? null;
		const nextActive = nextActiveSceneId
			? (normalizedScenes.find((scene) => scene.id === nextActiveSceneId) ??
				getMainScene({ scenes: normalizedScenes }))
			: getMainScene({ scenes: normalizedScenes });

		const activeProject = this.editor.project.getActive();
		if (activeProject) {
			const updatedProject = {
				...activeProject,
				scenes: normalizedScenes,
				...(nextActive && { currentSceneId: nextActive.id }),
				metadata: {
					...activeProject.metadata,
					updatedAt: new Date(),
				},
			};
			this.editor.project.setActiveProject({ project: updatedProject });
		}
		this.list = normalizedScenes;
		this.active = nextActive;
		this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}

	updateSceneTracks({ tracks }: { tracks: SceneTracks }): void {
		if (!this.active) return;

		const updatedScene: TScene = {
			...this.active,
			tracks,
			updatedAt: new Date(),
		};

		const nextScenes = this.list.map((s) =>
			s.id === this.active?.id ? updatedScene : s,
		);

		const activeProject = this.editor.project.getActive();
		if (activeProject) {
			const updatedProject = {
				...activeProject,
				scenes: nextScenes,
				metadata: {
					...activeProject.metadata,
					updatedAt: new Date(),
				},
			};
			this.editor.project.setActiveProject({ project: updatedProject });
		}
		this.list = nextScenes;
		this.active = updatedScene;
		this.notify();
	}
}
