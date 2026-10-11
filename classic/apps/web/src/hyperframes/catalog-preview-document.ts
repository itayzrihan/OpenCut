import { injectScriptsIntoHtml } from "@hyperframes/core/compiler/html-document";
import { getHyperframeRuntimeScript } from "./vendor/catalog-runtime-0.8.146";

/** Derived, silent catalog playback. This never encodes frames or edits source. */
export function catalogPreviewDocument({
	html,
	durationSeconds,
}: {
	html: string;
	durationSeconds: number;
}): string {
	return injectScriptsIntoHtml(
		html,
		[
			`(${installCatalogPlayback.toString()})(${JSON.stringify(durationSeconds)});`,
			getHyperframeRuntimeScript(),
		],
		[],
		true,
	);
}
function installCatalogPlayback(fallbackDuration: number) {
	const page = window as typeof window & {
		__player?: {
			play(): void;
			pause(): void;
			seek(time: number): Promise<void> | void;
			getTime(): number;
			getDuration?(): number;
		};
		__renderReady?: boolean;
	};
	const notify = ({ type, message }: { type: string; message?: string }) =>
		window.parent.postMessage(
			{ source: "opencut-catalog", type, message },
			"*",
		);
	const mute = () =>
		document
			.querySelectorAll<HTMLMediaElement>("video,audio")
			.forEach((media) => {
				media.muted = true;
				media.volume = 0;
			});
	// Prevent author-created Web Audio from bypassing silent hover playback.
	if (window.AudioContext) {
		AudioContext.prototype.resume = function () {
			return this.suspend().then(() => undefined);
		};
	}
	new MutationObserver(mute).observe(document, {
		childList: true,
		subtree: true,
	});
	let started = false,
		looping = false;
	const deadline = setTimeout(() => {
		if (!started)
			notify({
				type: "error",
				message:
					"The source preview did not become ready. Its dependencies may be unavailable.",
			});
	}, 20000);
	const timer = setInterval(() => {
		mute();
		window.postMessage(
			{
				source: "hf-parent",
				type: "control",
				action: "set-media-output-muted",
				muted: true,
			},
			"*",
		);
		const player = page.__player;
		if (!player || !page.__renderReady) return;
		if (!started) {
			started = true;
			clearTimeout(deadline);
			player.play();
			notify({ type: "ready" });
		}
		const duration = player.getDuration?.() || fallbackDuration;
		if (!looping && player.getTime() >= duration - 0.05) {
			looping = true;
			Promise.resolve(player.seek(0))
				.then(() => player.play())
				.finally(() => {
					looping = false;
				});
		}
	}, 100);
	window.addEventListener("pagehide", () => {
		clearInterval(timer);
		clearTimeout(deadline);
		page.__player?.pause();
	});
	window.addEventListener("error", (event) =>
		notify({
			type: "error",
			message: event.message || "Source preview failed",
		}),
	);
}
