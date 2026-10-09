/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Browser geometry and events are injected test doubles. */
import { expect, mock, test } from "bun:test";
import type { PlayheadConfig } from "../playhead-controller";
import { mediaTimeFromSeconds as seconds } from "@/wasm/media-time";
mock.module("@/timeline", () => ({
	getDisplayTracks: ({
		tracks,
	}: {
		tracks: { main: unknown; overlay: unknown[]; audio: unknown[] };
	}) => [...tracks.overlay, tracks.main, ...tracks.audio],
	timelineTimeToPixels: ({
		time,
		zoomLevel,
	}: {
		time: number;
		zoomLevel: number;
	}) => (time / 120000) * 50 * zoomLevel,
}));
mock.module("@/timeline/animation-snap-points", () => ({
	getAnimationKeyframeSnapPointsForTimeline: () => [],
}));
mock.module("@/timeline/bookmarks/index", () => ({
	getBookmarkSnapPoints: () => [],
}));
const { PlayheadController } = await import("../playhead-controller");

test("scrubbing inside the viewport cannot invoke playback follow; edge scrolling reseeks under a stationary pointer", () => {
	const oldWindow = globalThis.window;
	const listeners = new Map<string, (event: MouseEvent) => void>();
	globalThis.window = {
		// eslint-disable-next-line opencut/prefer-object-params -- DOM EventTarget signature.
		addEventListener: (name: string, listener: (event: MouseEvent) => void) =>
			listeners.set(name, listener),
		removeEventListener: (name: string) => listeners.delete(name),
	} as unknown as Window & typeof globalThis;
	try {
		const viewport = {
			scrollLeft: 400,
			clientWidth: 600,
			scrollWidth: 5000,
		} as HTMLDivElement;
		const ruler = {
			getBoundingClientRect: () => ({ left: 200 - viewport.scrollLeft }),
		} as HTMLDivElement;
		const handle = {
			style: {},
			setAttribute: () => {},
		} as unknown as HTMLDivElement;
		let current = seconds({ seconds: 0 });
		let scrubbing = false;
		const config: PlayheadConfig = {
			zoomLevel: 1,
			duration: seconds({ seconds: 100 }),
			getActiveProjectFps: () => ({ numerator: 30, denominator: 1 }),
			isShiftHeld: () => true,
			getIsPlaying: () => true,
			getRulerEl: () => ruler,
			getRulerScrollEl: () => viewport,
			getTracksScrollEl: () => viewport,
			getPlayheadEl: () => handle,
			getSceneTracks: () =>
				({ main: { elements: [] }, overlay: [], audio: [] }) as never,
			getSceneBookmarks: () => [],
			seek: (time) => {
				current = time;
			},
			setScrubbing: (value) => {
				scrubbing = value;
			},
			setTimelineViewState: () => {},
		};
		const controller = new PlayheadController({
			configRef: { current: config },
		});
		controller.onPlayheadMouseDown({
			button: 0,
			clientX: 500,
			preventDefault: () => {},
			stopPropagation: () => {},
		} as never);
		expect(scrubbing).toBe(true);
		expect(controller.getLastMouseClientX()).toBe(500);
		controller.handlePlaybackUpdate(seconds({ seconds: 90 }));
		expect(viewport.scrollLeft).toBe(400);
		expect(current).toBe(seconds({ seconds: 14 }));
		viewport.scrollLeft += 50;
		controller.handleScroll(current);
		expect(current).toBe(seconds({ seconds: 15 }));
		listeners.get("mouseup")!({ clientX: 500 } as MouseEvent);
		expect(scrubbing).toBe(false);
		expect(controller.isActive).toBe(false);
		const settled = current;
		viewport.scrollLeft += 50;
		controller.handleScroll(current);
		expect(current).toBe(settled);
		expect(listeners.size).toBe(0);
	} finally {
		globalThis.window = oldWindow;
	}
});
