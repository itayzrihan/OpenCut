import { create } from "zustand";
import { flushSync } from "react-dom";
import type { Bookmark } from "@/timeline/types";
import type {
	PreviewOverlayControl,
	PreviewOverlayInstance,
} from "../overlays";

const playbackListeners = new Set<() => void>();
const seekListeners = new Set<() => void>();
const sceneListeners = new Set<() => void>();
const subscribe = (listeners: Set<() => void>) => (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
let time = 0;
let renders = 0;
let scene = { id: "scene", bookmarks: [] as Bookmark[], parallax: false };
const project = { settings: { canvasSize: { width: 640, height: 360 } } };
const editor = {
	playback: {
		getCurrentTime: () => time,
		subscribe: () => () => {},
		onUpdate: subscribe(playbackListeners),
		onSeek: subscribe(seekListeners),
	},
	timeline: {
		getTotalDuration: () => 1000,
		subscribe: subscribe(sceneListeners),
	},
	scenes: {
		getActiveSceneOrNull: () => scene,
		subscribe: subscribe(sceneListeners),
	},
	project: { getActive: () => project, subscribe: () => () => {} },
};
export const EditorCore = { getInstance: () => editor };
export const ZERO_MEDIA_TIME = 0;
export const addMediaTime = ({ a, b }: { a: number; b: number }) => a + b;
export const roundFrameTime = () => {
	throw new Error("Unexpected frame rounding in bookmark overlay");
};
export const useCameraManStore = create(() => ({
	phase: "idle",
	sceneId: null,
	current: null,
}));
export const usePreviewStore = create<{
	activeGuide: null;
	overlays: Record<string, boolean>;
	setOverlayVisibility: (input: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
}>((set) => ({
	activeGuide: null,
	overlays: {},
	setOverlayVisibility: ({ overlayId, isVisible }) =>
		set((state) => ({
			overlays: { ...state.overlays, [overlayId]: isVisible },
		})),
}));
export const getGuidePreviewOverlaySource = () => ({
	definitions: [],
	instances: [],
});
export const getParallaxCanvasPreviewOverlaySource = ({
	scene: activeScene,
	currentTime,
}: {
	scene: typeof scene;
	currentTime: number;
}) => ({
	definitions: [],
	instances: activeScene.parallax
		? [{ id: "camera", render: () => <span data-camera>{currentTime}</span> }]
		: [],
});
export function PreviewPanel({
	overlayControls,
	overlayInstances,
	onOverlayVisibilityChange,
}: {
	overlayControls: PreviewOverlayControl[];
	overlayInstances: PreviewOverlayInstance[];
	onOverlayVisibilityChange: (input: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
}) {
	renders++;
	return (
		<div>
			{overlayControls.map((control) => (
				<button
					key={control.id}
					onClick={() =>
						onOverlayVisibilityChange({
							overlayId: control.id,
							isVisible: !control.isVisible,
						})
					}
				>
					{control.label}
				</button>
			))}
			<div data-overlays>
				{overlayInstances.map((overlay) => (
					<div key={overlay.id}>
						{overlay.render({ sceneWidth: 640, sceneHeight: 360 })}
					</div>
				))}
			</div>
		</div>
	);
}

export const controls = {
	setTime: ({ next, seek = false }: { next: number; seek?: boolean }) =>
		flushSync(() => {
			time = next;
			for (const listener of seek ? seekListeners : playbackListeners)
				listener();
		}),
	setBookmarks: (bookmarks: Bookmark[]) =>
		flushSync(() => {
			scene = { ...scene, bookmarks };
			for (const listener of sceneListeners) listener();
		}),
	setParallax: (parallax: boolean) =>
		flushSync(() => {
			scene = { ...scene, parallax };
			for (const listener of sceneListeners) listener();
		}),
	setVisible: (isVisible: boolean) =>
		flushSync(() =>
			usePreviewStore
				.getState()
				.setOverlayVisibility({ overlayId: "bookmark-notes", isVisible }),
		),
	read: () => ({
		renders,
		notes: document.querySelector('[aria-live="polite"]')?.textContent ?? "",
		camera: document.querySelector("[data-camera]")?.textContent ?? null,
	}),
};
declare global {
	interface Window {
		overlayFixture: typeof controls;
	}
}
window.overlayFixture = controls;
