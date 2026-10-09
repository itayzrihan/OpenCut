/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Minimal DOM/React lifecycle adapters exercise the real animation loop. */
import { expect, mock, test } from "bun:test";
let cleanup: (() => void) | undefined;
mock.module("react", () => ({
	useRef: (current: unknown) => ({ current }),
	useEffect: (effect: () => (() => void) | undefined) => {
		cleanup = effect();
	},
}));
const { useEdgeAutoScroll } = await import("../use-edge-auto-scroll");

test("scrubbing scrolls only in the narrow viewport edges and stops on return or release", () => {
	const oldRequest = globalThis.requestAnimationFrame;
	const oldCancel = globalThis.cancelAnimationFrame;
	let frame: FrameRequestCallback | undefined;
	globalThis.requestAnimationFrame = (callback) => {
		frame = callback;
		return 1;
	};
	globalThis.cancelAnimationFrame = () => {
		frame = undefined;
	};
	try {
		const viewport = {
			scrollLeft: 300,
			clientWidth: 600,
			scrollWidth: 2000,
			getBoundingClientRect: () => ({ left: 200 }),
		} as HTMLDivElement;
		const tracks = { scrollLeft: 300 } as HTMLDivElement;
		let mouse = 500;
		useEdgeAutoScroll({
			isActive: true,
			getMouseClientX: () => mouse,
			rulerScrollRef: { current: viewport },
			tracksScrollRef: { current: tracks },
			contentWidth: 2000,
			edgeThreshold: 24,
		});
		for (mouse of [250, 500, 750]) {
			frame!(0);
			expect(viewport.scrollLeft).toBe(300);
		}
		mouse = 790;
		frame!(0);
		expect(viewport.scrollLeft).toBeGreaterThan(300);
		expect(tracks.scrollLeft).toBe(viewport.scrollLeft);
		const scrolled = viewport.scrollLeft;
		mouse = 500;
		frame!(0);
		expect(viewport.scrollLeft).toBe(scrolled);
		mouse = 210;
		frame!(0);
		expect(viewport.scrollLeft).toBeLessThan(scrolled);
		viewport.scrollLeft = 0;
		mouse = 190;
		frame!(0);
		expect(viewport.scrollLeft).toBe(0);
		viewport.scrollLeft = 1400;
		mouse = 810;
		frame!(0);
		expect(viewport.scrollLeft).toBe(1400);
		cleanup?.();
		expect(frame).toBeUndefined();
	} finally {
		cleanup?.();
		globalThis.requestAnimationFrame = oldRequest;
		globalThis.cancelAnimationFrame = oldCancel;
	}
});

test("an inactive scrub never starts scrolling from an old pointer position", () => {
	useEdgeAutoScroll({
		isActive: false,
		getMouseClientX: () => 0,
		rulerScrollRef: { current: null },
		tracksScrollRef: { current: null },
		contentWidth: 2000,
	});
	expect(cleanup).toBeUndefined();
});
