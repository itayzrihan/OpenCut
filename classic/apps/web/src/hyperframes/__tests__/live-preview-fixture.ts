/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Browser surfaces are protocol doubles. */
import { expect } from "bun:test";

export function livePreviewFixture() {
	const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const browser = new EventTarget();
	const frames: HTMLIFrameElement[] = [];
	const attached = new Set<HTMLIFrameElement>();
	const controls: Array<{
		frame: HTMLIFrameElement;
		type: string;
		timeSeconds?: number;
		playing?: boolean;
	}> = [];
	const message = ({
		frame,
		data,
	}: {
		frame: HTMLIFrameElement;
		data: object;
	}) => {
		browser.dispatchEvent(
			Object.assign(new Event("message"), {
				source: frame.contentWindow,
				data: { source: "opencut-hf-live", ...data },
			}),
		);
	};
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: browser,
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			createElement: (tag: string) => {
				if (tag === "canvas")
					return { style: {}, setAttribute() {}, remove() {} };
				const frame = {
					style: {},
					setAttribute() {},
					remove: () => attached.delete(frame),
					contentWindow: {
						postMessage: (data: {
							type: string;
							sequence: number;
							timeSeconds?: number;
							playing?: boolean;
						}) => {
							controls.push({ frame, ...data });
							if (data.type === "seek")
								queueMicrotask(() =>
									message({
										frame,
										data: { type: "frame", sequence: data.sequence },
									}),
								);
						},
					},
				} as unknown as HTMLIFrameElement;
				frames.push(frame);
				return frame;
			},
		},
	});
	const mount = {
		style: {},
		appendChild: (frame: HTMLIFrameElement) => {
			if (!frame.contentWindow) return;
			attached.add(frame);
			expect(attached.size).toBeLessThanOrEqual(5);
			queueMicrotask(() => message({ frame, data: { type: "ready" } }));
		},
	} as unknown as HTMLElement;
	return {
		frames,
		attached,
		controls,
		message,
		mount,
		renderer: {
			width: 640,
			height: 360,
			render: async () => {},
			renderWithOverlays: async () => {},
		} as unknown as import("@/services/renderer/canvas-renderer").CanvasRenderer,
		restore: () => {
			if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
			else Reflect.deleteProperty(globalThis, "window");
			if (savedDocument)
				Object.defineProperty(globalThis, "document", savedDocument);
			else Reflect.deleteProperty(globalThis, "document");
		},
	};
}
