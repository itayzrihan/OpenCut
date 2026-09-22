/** Local source decoding + OpenCV + local pose inference. Rust owns detection acceptance and crop math. */
import type { EditorCore } from "@/core";
import { resolveLocalSubjectFraming, compileFullAutoEdit } from "opencut-wasm";
import {
	buildTimelineDocumentV2,
	parseTimelineDocumentV2,
} from "./timeline-document-v2";
import { updateSceneInArray } from "@/timeline/scenes";
function waitForVideo({
	video,
	event,
	signal,
}: {
	video: HTMLVideoElement;
	event: string;
	signal: AbortSignal;
}) {
	return new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			video.removeEventListener(event, done);
			video.removeEventListener("error", fail);
			signal.removeEventListener("abort", abort);
		};
		const done = () => {
			cleanup();
			resolve();
		};
		const fail = () => {
			cleanup();
			reject(new Error("Could not decode source video for face/body framing"));
		};
		const abort = () => {
			cleanup();
			reject(new DOMException("Cancelled", "AbortError"));
		};
		const timer = setTimeout(fail, 30000);
		video.addEventListener(event, done, { once: true });
		video.addEventListener("error", fail, { once: true });
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

export async function detectSubjectFraming({
	editor,
	signal,
	onProgress,
}: {
	editor: EditorCore;
	signal: AbortSignal;
	onProgress: (s: string) => void;
}) {
	const scene = editor.scenes.getActiveScene();
	const assets = editor.media.getAssets();
	const groups = new Map<string, typeof scene.tracks.main.elements>();
	for (const clip of scene.tracks.main.elements) {
		if (clip.type !== "video")
			throw new Error("Subject framing requires main-track video");
		const group = groups.get(clip.mediaId) ?? [];
		group.push(clip);
		groups.set(clip.mediaId, group);
	}
	const results = [];
	let faceSamples = 0, bodySamples = 0;
	for (const [mediaId, clips] of groups) {
		signal.throwIfAborted();
		const asset = assets.find((a) => a.id === mediaId);
		if (!asset || (!asset.file && !asset.url))
			throw new Error("Original source media unavailable");
		onProgress(`Local face/body detection in ${asset.name} — no cloud request…`);
		const ownedUrl = asset.file ? URL.createObjectURL(asset.file) : null;
		const video = document.createElement("video");
		video.muted = true;
		video.preload = "auto";
		video.crossOrigin = "anonymous";
		try {
			const loaded = waitForVideo({ video, event: "loadeddata", signal });
			video.src = ownedUrl ?? asset.url!;
			await loaded;
			// One stable source crop across silence-cut fragments prevents framing jumps at every cut.
			const start = Math.min(...clips.map((c) => c.trimStart)) / 120000;
			const end =
				Math.max(...clips.map((c) => c.trimStart + c.duration)) / 120000;
			const frames: string[] = [];
			for (const fraction of [0.02, 0.25, 0.5, 0.75, 0.98]) {
				signal.throwIfAborted();
				const time = start + (end - start) * fraction;
				if (time >= video.duration)
					throw new Error("Clip extends beyond source media");
				if (Math.abs(video.currentTime - time) > 0.0001) {
					const seek = waitForVideo({ video, event: "seeked", signal });
					video.currentTime = time;
					await seek;
				}
				const canvas = document.createElement("canvas");
				canvas.width = 640;
				canvas.height = Math.round(
					(640 * video.videoHeight) / video.videoWidth,
				);
				const ctx = canvas.getContext("2d");
				if (!ctx) throw new Error("Frame capture unavailable");
				ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
				frames.push(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
			}
			const response = await fetch("/api/local-subject-framing", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ frames }),
				signal,
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? "Local detector failed");
			const resolved = resolveLocalSubjectFraming({
				detectionsJson: JSON.stringify(data),
			});
			if (!resolved.valid) throw new Error(`${asset.name}: ${resolved.error}`);
			faceSamples += resolved.acceptedFrames;
			bodySamples += resolved.bodyFrames;
			onProgress(
				`${asset.name}: ${resolved.acceptedFrames}/5 reliable local face samples; ${resolved.bodyFrames} matched pose samples`,
			);
			for (const clip of clips)
				results.push({
					elementId: clip.id,
					width: video.videoWidth,
					height: video.videoHeight,
					samples: JSON.parse(resolved.samplesJson),
				});
		} finally {
			video.pause();
			video.removeAttribute("src");
			video.load();
			if (ownedUrl) URL.revokeObjectURL(ownedUrl);
		}
	}
	return { framing: results, faceSamples, bodySamples };
}
export async function runLocalSubjectFraming({
	editor,
	signal,
	onProgress,
	mode = "center-subject",
}: {
	editor: EditorCore;
	signal: AbortSignal;
	onProgress: (s: string) => void;
	mode?: "center-subject" | "framing";
}) {
	const project = editor.project.getActive();
	const scene = editor.scenes.getActiveScene();
	const source = buildTimelineDocumentV2({ project, scene });
	if (!source.valid) throw new Error("Invalid Timeline Source");
	const { framing, faceSamples, bodySamples } = await detectSubjectFraming({ editor, signal, onProgress });
	signal.throwIfAborted();
	const current = editor.project.getActive(),
		active = editor.scenes.getActiveScene();
	if (
		current.metadata.id !== project.metadata.id ||
		active.id !== scene.id ||
		buildTimelineDocumentV2({ project: current, scene: active })
			.baseRevision !== source.baseRevision
	)
		throw new Error(
			"Timeline changed during local framing; no stale crop applied",
		);
	const result = compileFullAutoEdit({
		sourceJson: source.formattedText,
		stage: mode,
		framingJson: JSON.stringify(framing),
		fontFamily: "",
	});
	if (!result.valid) throw new Error(result.error);
	const parsed = parseTimelineDocumentV2({ text: result.sourceJson });
	const value = parsed.value;
	if (!parsed.valid || !value)
		throw new Error(parsed.diagnostics.map((d) => d.message).join("; "));
	editor.command.executeTransaction({
		execute: () => {
			if (mode === "framing")
				void editor.project.updateSettings({ settings: value.projectSettings });
			editor.scenes.setScenes({
				scenes: updateSceneInArray({
					scenes: editor.scenes.getScenes(),
					sceneId: scene.id,
					updates: { tracks: value.tracks, bookmarks: value.bookmarks },
				}),
				activeSceneId: scene.id,
			});
			editor.save.markDirty();
		},
	});
	await editor.save.flush();
	return {
		added: true,
		message: `Centered ${framing.length} clips using local face/body detection (${faceSamples} face samples, ${bodySamples} matched body samples). Stable crop; no cloud/LLM request. Undo restores the previous framing.`,
	};
}
