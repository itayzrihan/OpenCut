import { hyperframesMediaBridgeScript } from "./media-document";

/** Trusted transport shells for a package-only, silent live rendering surface.
 * No project mutation or author code runs in the editor's origin.
 */
export function hyperframesLiveBridgeScript({
	fps,
	durationSeconds,
}: {
	fps: number;
	durationSeconds: number;
}): string {
	return `${hyperframesMediaBridgeScript()}\n(${installLiveBridge.toString()})(${JSON.stringify({ fps, durationSeconds })});`;
}

/** The extra shell keeps its frame-src policy outside the authored document.
 * An author cannot navigate its frame to a new origin to shed the package CSP.
 */
export function hyperframesLiveShellHtml({
	entryPath,
}: {
	entryPath: string;
}): string {
	return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><script>(${installLiveShell.toString()})(${JSON.stringify(entryPath)});</script></body></html>`;
}

function installLiveShell(entryPath: string): void {
	const frame = document.createElement("iframe");
	frame.setAttribute("sandbox", "allow-scripts");
	frame.setAttribute(
		"allow",
		"autoplay 'none'; camera 'none'; microphone 'none'",
	);
	frame.setAttribute("tabindex", "-1");
	frame.src = entryPath;
	let loads = 0;
	const fail = () =>
		window.parent.postMessage(
			{
				source: "opencut-hf-live",
				type: "error",
				message: "Live composition navigation was blocked",
			},
			"*",
		);
	frame.addEventListener("load", () => {
		if (++loads > 1) fail();
	});
	window.addEventListener("securitypolicyviolation", fail);
	window.addEventListener("message", (event) => {
		const data = event.data;
		if (!data || data.source !== "opencut-hf-live") return;
		if (
			event.source === window.parent &&
			(data.type === "seek" || data.type === "pause")
		) {
			frame.contentWindow?.postMessage(
				{
					source: "opencut-hf-live",
					type: data.type,
					sequence: data.sequence,
					timeSeconds: data.timeSeconds,
					playing: data.playing,
					sampledAt: data.sampledAt,
					endTimeSeconds: data.endTimeSeconds,
					diagnostics: data.diagnostics === true,
				},
				"*",
			);
		} else if (event.source === frame.contentWindow) {
			if (
				data.type === "loading" &&
				["runtime", "fonts", "images", "media"].includes(data.stage)
			)
				window.parent.postMessage(
					{ source: "opencut-hf-live", type: "loading", stage: data.stage },
					"*",
				);
			if (data.type === "ready")
				window.parent.postMessage(
					{ source: "opencut-hf-live", type: "ready" },
					"*",
				);
			if (data.type === "frame" && Number.isSafeInteger(data.sequence))
				window.parent.postMessage(
					{
						source: "opencut-hf-live",
						type: "frame",
						sequence: data.sequence,
						metrics: data.metrics,
					},
					"*",
				);
			if (data.type === "error")
				window.parent.postMessage(
					{
						source: "opencut-hf-live",
						type: "error",
						message: String(data.message).slice(0, 200),
					},
					"*",
				);
		}
	});
	window.parent.postMessage(
		{ source: "opencut-hf-live", type: "loading", stage: "document" },
		"*",
	);
	document.body.append(frame);
}

/** This function is stringified into the isolated document. Keep it self-contained. */
function installLiveBridge({
	fps,
	durationSeconds,
}: {
	fps: number;
	durationSeconds: number;
}): void {
	// The Classic mixer owns sound. Keep analysis/animation audio graphs usable,
	// but prevent their nodes from connecting to the physical output device.
	// This also holds in capture browsers launched with autoplay enabled.
	for (const method of ["connect", "disconnect"] as const) {
		const original = AudioNode.prototype[method];
		Object.defineProperty(AudioNode.prototype, method, {
			configurable: true,
			writable: true,
			value: function (this: AudioNode, ...args: unknown[]) {
				if (args[0] instanceof AudioDestinationNode)
					return method === "connect" ? args[0] : undefined;
				return Reflect.apply(original, this, args);
			},
		});
	}
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Pinned runtime fields inside its own isolated document.
	const page = window as unknown as {
		__HF_RENDER_CAPTURE_MODE?: boolean;
		__HF_EXPORT_RENDER_SEEK_CONFIG?: object;
		__renderReady?: boolean;
		__opencutLayerEdits?: import("./layer-edits").HyperframesLayerEditBridge;
		__hfTimelinesBuilding?: boolean;
		__opencutMedia: import("./media-document").HyperframesMediaBridge;
		__hf_page_composite_pending?: boolean;
		__player?: {
			renderSeek: (time: number, options?: object) => void;
			seek: (
				time: number,
				options?: { keepPlaying?: boolean },
			) => void | Promise<void>;
			play: () => void;
			pause: () => void;
			getTime: () => number;
			isPlaying: () => boolean;
		};
	};
	const options = {
		mode: "preview-phase",
		step: 1 / 120,
		offsetFraction: 0.5,
		fps,
		fpsSource: "render-options",
		owner: "runtime",
	};
	page.__HF_RENDER_CAPTURE_MODE = true;
	page.__HF_EXPORT_RENDER_SEEK_CONFIG = options;
	let ready = false;
	let failed = false;
	let lastSequence = 0;
	let seeking = false;
	let playbackEpoch = 0;
	let playbackLease: ReturnType<typeof setTimeout> | undefined;
	const pausePlayback = () => {
		playbackEpoch++;
		clearTimeout(playbackLease);
		page.__player?.pause();
	};
	const post = (data: object) =>
		window.parent.postMessage({ source: "opencut-hf-live", ...data }, "*");
	post({ type: "loading", stage: "runtime" });
	const fail = (message: string) => {
		if (failed) return;
		failed = true;
		pausePlayback();
		post({ type: "error", message: message.slice(0, 200) });
	};
	const mute = () => {
		for (const media of document.querySelectorAll<HTMLMediaElement>(
			"audio,video",
		))
			media.muted = true;
		window.postMessage(
			{
				source: "hf-parent",
				type: "control",
				action: "set-media-output-muted",
				muted: true,
			},
			"*",
		);
		window.postMessage(
			{
				source: "hf-parent",
				type: "control",
				action: "set-muted",
				muted: true,
			},
			"*",
		);
	};
	window.addEventListener("securitypolicyviolation", () =>
		fail("Live preview needs a resource outside its registered package"),
	);
	window.addEventListener(
		"error",
		() => fail("Live preview could not load its scripts or resources"),
		true,
	);
	window.addEventListener("unhandledrejection", () =>
		fail("Live preview runtime failed"),
	);
	new MutationObserver(() => {
		for (const media of document.querySelectorAll<HTMLMediaElement>(
			"audio,video",
		))
			media.muted = true;
	}).observe(document.documentElement, { childList: true, subtree: true });
	const deadline = setTimeout(
		() => fail("Live preview did not become ready"),
		30_000,
	);
	const poll = setInterval(() => {
		if (failed) {
			clearInterval(poll);
			clearTimeout(deadline);
			return;
		}
		if (
			!page.__renderReady ||
			page.__hfTimelinesBuilding ||
			!page.__player?.renderSeek
		)
			return;
		clearInterval(poll);
		void (async () => {
			mute();
			page.__player?.pause();
			post({ type: "loading", stage: "fonts" });
			await document.fonts.ready;
			post({ type: "loading", stage: "images" });
			await Promise.all([...document.images].map((image) => image.decode()));
			if (document.querySelector("video")) {
				post({ type: "loading", stage: "media" });
			}
			await page.__opencutMedia.ready();
			if (failed) return;
			ready = true;
			clearTimeout(deadline);
			post({ type: "ready" });
		})().catch((error: unknown) =>
			fail(
				error instanceof Error ? error.message : "Live preview assets failed",
			),
		);
	}, 20);
	window.addEventListener("message", (event) => {
		const data = event.data;
		if (
			event.source !== window.parent ||
			!data ||
			data.source !== "opencut-hf-live" ||
			failed ||
			!ready
		)
			return;
		if (data.type === "pause") {
			pausePlayback();
			return;
		}
		if (data.type !== "seek") return;
		if (
			!Number.isSafeInteger(data.sequence) ||
			data.sequence <= lastSequence ||
			!Number.isFinite(data.timeSeconds) ||
			data.timeSeconds < 0 ||
			data.timeSeconds >= durationSeconds
		)
			return;
		lastSequence = data.sequence;
		if (seeking) {
			fail("Live preview received overlapping frame requests");
			return;
		}
		seeking = true;
		const epoch = playbackEpoch;
		void (async () => {
			const startedAt = performance.now();
			let driftMs = 0;
			let resynced = false;
			mute();
			// Continuous native decoding is driven by the parent's sampled clock.
			// Edited layers and Canvas draws still use the exact seek barrier:
			// their before/after hooks must cover every evaluated animation frame.
			const continuous =
				data.playing === true &&
				Number.isFinite(data.sampledAt) &&
				Number.isFinite(data.endTimeSeconds) &&
				data.endTimeSeconds > data.timeSeconds &&
				data.endTimeSeconds <= durationSeconds &&
				!page.__opencutLayerEdits &&
				!!document.querySelector("video") &&
				!document.querySelector("canvas");
			if (continuous) {
				const end = Math.min(data.endTimeSeconds, durationSeconds);
				const elapsed = Math.max(
					0,
					Math.min(
						30,
						(performance.timeOrigin + performance.now() - data.sampledAt) /
							1000,
					),
				);
				const target = Math.min(end - 1 / fps, data.timeSeconds + elapsed);
				const player = page.__player!;
				driftMs = Math.abs(player.getTime() - target) * 1000;
				if (driftMs > 1500 / fps) {
					resynced = true;
					// A warm resync must keep the runtime clock running while native
					// media catches up. Pausing to decode would create another drift.
					await player.seek(Math.max(0, target), { keepPlaying: true });
				}
				if (!player.isPlaying()) {
					// Starting before the first seek decodes can strand a cold native
					// video on its initial frame while the runtime clock advances.
					await page.__opencutMedia.finishSeek();
				}
				if (epoch === playbackEpoch && !failed && !player.isPlaying()) {
					player.play();
				}
				if (epoch === playbackEpoch && !failed) {
					clearTimeout(playbackLease);
					// Stop when the parent stops supplying frames, or at the clip's end.
					playbackLease = setTimeout(
						pausePlayback,
						Math.max(0, Math.min(200, (end - player.getTime()) * 1000)),
					);
				}
			} else {
				pausePlayback();
				page.__opencutLayerEdits?.beforeSeek();
				page.__player!.renderSeek(
					// Match the pinned engine's quantizeTimeToFrame before renderSeek.
					Math.floor(data.timeSeconds * fps + 1e-9) / fps,
					options,
				);
				page.__opencutLayerEdits?.afterSeek();
				await page.__opencutMedia.finishSeek();
			}
			if (page.__hf_page_composite_pending)
				throw new Error(
					"Live preview requires capture for this page compositor",
				);
			if (failed) return;
			post({
				type: "frame",
				sequence: data.sequence,
				...(data.diagnostics === true
					? {
							metrics: {
								continuous,
								resynced,
								driftMs,
								renderMs: performance.now() - startedAt,
							},
						}
					: {}),
			});
		})()
			.catch((error: unknown) =>
				fail(
					error instanceof Error ? error.message : "Live preview seek failed",
				),
			)
			.finally(() => {
				seeking = false;
			});
	});
}
