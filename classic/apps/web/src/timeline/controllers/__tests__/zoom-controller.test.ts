/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Only the scroll geometry used by the controller is needed for these DOM doubles. */
import { expect, test } from "bun:test";
import { ZoomController, type ZoomConfig } from "../zoom-controller";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import { mediaTimeFromSeconds } from "@/wasm/media-time";
import { TIMELINE_ZOOM_MAX } from "@/timeline/scale";

function fixture() {
	const tracks = { clientWidth: 1000, scrollWidth: 20_000, scrollLeft: 9000 };
	const ruler = { scrollLeft: 9000 };
	const saved: Parameters<ZoomConfig["setTimelineViewState"]>[0][] = [];
	const seeks: number[] = [];
	const playhead = mediaTimeFromSeconds({ seconds: 175 });
	const config: ZoomConfig = {
		minZoom: 0.01,
		getContainerEl: () => null,
		getTracksScrollEl: () => tracks as unknown as HTMLDivElement,
		getRulerScrollEl: () => ruler as unknown as HTMLDivElement,
		getCurrentPlayheadTime: () => playhead,
		seek: (time) => seeks.push(time),
		setTimelineViewState: (state) => saved.push(state),
	};
	const controller = new ZoomController({
		configRef: { current: config },
		initialZoom: 5,
	});
	return { controller, config, tracks, ruler, saved, seeks, playhead };
}

test("fit shows a long timeline from zero while preserving its playhead", () => {
	const f = fixture();
	const duration = mediaTimeFromSeconds({ seconds: 180 });
	f.controller.fitToContent({ duration });
	f.controller.applyZoomLayout(f.controller.zoomLevel);
	expect(
		timelineTimeToPixels({ time: duration, zoomLevel: f.controller.zoomLevel }),
	).toBeCloseTo(900);
	expect(f.tracks.scrollLeft).toBe(0);
	expect(f.ruler.scrollLeft).toBe(0);
	expect(f.seeks).toEqual([]);
	expect(f.saved).toEqual([
		{ zoomLevel: 0.1, scrollLeft: 0, playheadTime: f.playhead },
	]);
	f.controller.restoreInitialScrollIfNeeded(9000);
	expect(f.tracks.scrollLeft).toBe(0);
	f.controller.destroy();
});

test("fit resets a scrolled view even when zoom is unchanged and uses the current width", () => {
	const f = fixture();
	const duration = mediaTimeFromSeconds({ seconds: 180 });
	f.controller.fitToContent({ duration });
	f.controller.applyZoomLayout(f.controller.zoomLevel);
	f.tracks.scrollLeft = f.ruler.scrollLeft = 250;
	f.controller.fitToContent({ duration });
	expect(f.tracks.scrollLeft).toBe(0);
	expect(f.ruler.scrollLeft).toBe(0);
	expect(f.saved).toHaveLength(2);
	f.tracks.clientWidth = 600;
	f.controller.fitToContent({ duration });
	f.controller.applyZoomLayout(f.controller.zoomLevel);
	expect(
		timelineTimeToPixels({ time: duration, zoomLevel: f.controller.zoomLevel }),
	).toBeCloseTo(540);
	expect(f.saved.at(-1)?.playheadTime).toBe(f.playhead);
	f.controller.destroy();
});

test("fit supports empty and short timelines, clamps zoom and ignores unavailable layout", () => {
	const f = fixture();
	f.controller.fitToContent({ duration: 0 });
	f.controller.applyZoomLayout(f.controller.zoomLevel);
	expect(f.controller.zoomLevel).toBe(18);
	f.tracks.clientWidth = 10_000;
	f.controller.fitToContent({
		duration: mediaTimeFromSeconds({ seconds: 0.1 }),
	});
	f.controller.applyZoomLayout(f.controller.zoomLevel);
	expect(f.controller.zoomLevel).toBe(TIMELINE_ZOOM_MAX);
	const saved = f.saved.length;
	f.tracks.clientWidth = 0;
	f.controller.fitToContent({
		duration: mediaTimeFromSeconds({ seconds: 180 }),
	});
	f.tracks.clientWidth = 1000;
	f.controller.fitToContent({ duration: Number.NaN });
	f.controller.fitToContent({ duration: -1 });
	expect(f.saved).toHaveLength(saved);
	expect(f.controller.zoomLevel).toBe(TIMELINE_ZOOM_MAX);
	f.controller.destroy();
});
