/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The DOM double provides scroll geometry and events without a browser dependency. */
import { expect, test } from "bun:test";
import {
	observeScrollPosition,
	type ScrollPosition,
} from "../use-scroll-position";

test("scroll observation resumes after Strict Mode cancels its first pending frame", () => {
	const positions: ScrollPosition[] = [];
	const globals = [
		"requestAnimationFrame",
		"cancelAnimationFrame",
		"ResizeObserver",
	] as const;
	const original = globals.map((key) =>
		Object.getOwnPropertyDescriptor(globalThis, key),
	);
	const frames = new Map<number, FrameRequestCallback>();
	let nextFrame = 0;
	const resizeCallbacks = new Set<() => void>();
	const element = Object.assign(new EventTarget(), {
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: 1100,
		clientHeight: 250,
	});
	const overrides = {
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++nextFrame, callback);
			return nextFrame;
		},
		cancelAnimationFrame: (id: number) => {
			frames.delete(id);
		},
		ResizeObserver: class {
			constructor(private readonly callback: () => void) {}
			observe() {
				resizeCallbacks.add(this.callback);
			}
			disconnect() {
				resizeCallbacks.delete(this.callback);
			}
		},
	};
	const flushFrames = () => {
		for (const [id, callback] of [...frames]) {
			frames.delete(id);
			callback(0);
		}
	};
	let cleanup: void | (() => void) = undefined;
	try {
		for (const key of globals)
			Object.defineProperty(globalThis, key, {
				configurable: true,
				value: overrides[key],
			});
		const setup = () =>
			observeScrollPosition({
				scrollElement: element as unknown as HTMLElement,
				onChange: (position) => positions.push(position),
			});
		cleanup = setup();
		expect(frames.size).toBe(1);
		cleanup?.();
		expect(frames.size).toBe(0);
		cleanup = setup();
		expect(frames.size).toBe(1);
		flushFrames();
		expect(positions.at(-1)?.viewportWidth).toBe(1100);
		element.scrollLeft = 500;
		element.dispatchEvent(new Event("scroll"));
		element.dispatchEvent(new Event("scroll"));
		expect(frames.size).toBe(1);
		flushFrames();
		expect(positions.at(-1)?.scrollLeft).toBe(500);
		element.clientWidth = 800;
		for (const resize of resizeCallbacks) resize();
		flushFrames();
		expect(positions.at(-1)?.viewportWidth).toBe(800);
		cleanup?.();
		expect(resizeCallbacks.size).toBe(0);
		element.dispatchEvent(new Event("scroll"));
		expect(frames.size).toBe(0);
	} finally {
		cleanup?.();
		globals.forEach((key, index) => {
			const descriptor = original[index];
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		});
	}
});
