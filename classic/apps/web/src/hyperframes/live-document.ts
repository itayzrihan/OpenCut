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
	return `(${installLiveBridge.toString()})(${JSON.stringify({ fps, durationSeconds })});`;
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
		if (event.source === window.parent && data.type === "seek") {
			frame.contentWindow?.postMessage(
				{
					source: "opencut-hf-live",
					type: "seek",
					sequence: data.sequence,
					timeSeconds: data.timeSeconds,
				},
				"*",
			);
		} else if (event.source === frame.contentWindow) {
			if (data.type === "ready")
				window.parent.postMessage(
					{ source: "opencut-hf-live", type: "ready" },
					"*",
				);
			if (data.type === "frame" && Number.isSafeInteger(data.sequence))
				window.parent.postMessage(
					{ source: "opencut-hf-live", type: "frame", sequence: data.sequence },
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
		__hfTimelinesBuilding?: boolean;
		__player?: {
			renderSeek: (time: number, options?: object) => void;
			pause: () => void;
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
	const post = (data: object) =>
		window.parent.postMessage({ source: "opencut-hf-live", ...data }, "*");
	const fail = (message: string) => {
		if (failed) return;
		failed = true;
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
			// Native video seeking and shader/canvas rendering still need the
			// verified capture adapter; never silently replace their pixels.
			if (document.querySelector("video,canvas"))
				throw new Error(
					"Live preview requires the capture adapter for video or canvas layers",
				);
			mute();
			page.__player?.pause();
			await document.fonts.ready;
			await Promise.all([...document.images].map((image) => image.decode()));
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
			data.type !== "seek" ||
			failed ||
			!ready
		)
			return;
		if (
			!Number.isSafeInteger(data.sequence) ||
			data.sequence <= lastSequence ||
			!Number.isFinite(data.timeSeconds) ||
			data.timeSeconds < 0 ||
			data.timeSeconds >= durationSeconds
		)
			return;
		lastSequence = data.sequence;
		try {
			if (document.querySelector("video,canvas"))
				throw new Error(
					"Live preview requires the capture adapter for video or canvas layers",
				);
			mute();
			page.__player!.renderSeek(
				// Match the pinned engine's quantizeTimeToFrame before renderSeek.
				Math.floor(data.timeSeconds * fps + 1e-9) / fps,
				options,
			);
			if (document.querySelector("video,canvas"))
				throw new Error(
					"Live preview requires the capture adapter for video or canvas layers",
				);
			post({ type: "frame", sequence: data.sequence });
		} catch (error) {
			fail(error instanceof Error ? error.message : "Live preview seek failed");
		}
	});
}
