import { z } from "zod";
import type { EditorCore } from "@/core";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import { api, scope, uploadDirectorReference } from "./client";
import {
	REPLACE_IMAGE_MODEL,
	REPLACE_MAX_REFERENCES,
	REPLACE_VIDEO_MODEL,
	type VideoGenerationModel,
} from "./replace-model";
import type { DirectorJob, ReplaceMode, ReplaceTarget } from "./types";

type ClipIdentity = Pick<ReplaceTarget, "sceneId" | "trackId" | "elementId">;
const planSchema = z.object({ anchor: z.string(), durationTicks: z.number() });

export function planReplace({
	editor,
	target,
}: {
	editor: EditorCore;
	target: ClipIdentity;
}) {
	if (editor.scenes.getActiveSceneOrNull()?.id !== target.sceneId)
		throw new Error("Open the original scene to replace this clip");
	const { sceneId, trackId, elementId } = target;
	return planSchema.parse(
		editor.command.invokeCanonicalControl({
			...scope(editor),
			capabilityId: "timeline.classic.replace.plan",
			input: { target: { sceneId, trackId, elementId } },
		}),
	);
}

function nearestVideoAspect({
	width,
	height,
	model,
}: {
	width: number;
	height: number;
	model: VideoGenerationModel;
}) {
	const distance = (ratio: string) => {
		const [w, h] = ratio.split(":").map(Number);
		return Math.abs(Math.log(w / h / (width / height)));
	};
	return [...(model.supported_aspect_ratios ?? [])].sort(
		(a, b) => distance(a) - distance(b),
	)[0];
}

export function replacementDuration({
	model,
	ticks,
}: {
	model: VideoGenerationModel | undefined;
	ticks: number;
}) {
	const durations = (model?.supported_durations ?? [])
		.filter(
			(seconds) => Number.isInteger(seconds) && seconds >= 1 && seconds <= 30,
		)
		.sort((a, b) => a - b);
	return (
		durations.find((seconds) => seconds * TICKS_PER_SECOND >= ticks) ??
		durations.at(-1)
	);
}

function replacementFrameTimes({
	start,
	duration,
	frameStep,
}: {
	start: number;
	duration: number;
	frameStep: number;
}) {
	const lastFrame = Math.max(0, Math.ceil(duration / frameStep) - 1);
	const count = Math.min(REPLACE_MAX_REFERENCES, lastFrame + 1);
	return Array.from({ length: count }, (_, i) =>
		mediaTime({
			ticks:
				start +
				Math.min(
					duration - 1,
					Math.round(
						(count === 1 ? 0 : Math.round((i * lastFrame) / (count - 1))) *
							frameStep,
					),
				),
		}),
	);
}

export async function prepareReplacement({
	editor,
	target,
	mode,
	prompt,
	files,
	chosenReferences,
	model,
	generateImage,
	signal,
}: {
	editor: EditorCore;
	target: ClipIdentity;
	mode: ReplaceMode;
	prompt: string;
	files: File[];
	chosenReferences: string[];
	model?: VideoGenerationModel;
	generateImage: boolean;
	signal: AbortSignal;
}) {
	const original = scope(editor);
	const plan = planReplace({ editor, target });
	const project = editor.project.getActiveForScene();
	const clip = editor.timeline
		.getTrackById({ trackId: target.trackId })
		?.elements.find((element) => element.id === target.elementId);
	if (!project || clip?.type !== "video")
		throw new Error("The selected video is no longer on the timeline");
	const asset = editor.media.getAssets().find((a) => a.id === clip.mediaId);
	const check = () => {
		signal.throwIfAborted();
		const active = scope(editor);
		if (
			active.projectId !== original.projectId ||
			active.accountId !== original.accountId ||
			planReplace({ editor, target }).anchor !== plan.anchor
		)
			throw new Error(
				"The selected clip changed. Prepare the replacement again.",
			);
	};
	const duration = replacementDuration({ model, ticks: plan.durationTicks });
	const resolution = ["720p", "1080p", "480p"].find((size) =>
		model?.supported_resolutions?.includes(size),
	);
	const canvas = project.settings.canvasSize;
	const aspectRatio =
		model &&
		nearestVideoAspect({
			width: asset?.width || canvas.width,
			height: asset?.height || canvas.height,
			model,
		});
	if (!generateImage && (!duration || !resolution || !aspectRatio))
		throw new Error("Wan 3.0 is unavailable for this replacement");

	const referenceIds = mode === "full" ? [...chosenReferences] : [];
	async function upload({ file, name }: { file: Blob; name: string }) {
		check();
		const reference = await uploadDirectorReference({
			...original,
			file,
			name,
			signal,
		});
		referenceIds.push(reference.id);
	}
	if (mode === "refine") {
		const { numerator, denominator } = project.settings.fps;
		const frames = await editor.renderer.captureVideoSourceFrames({
			clip,
			times: replacementFrameTimes({
				start: clip.startTime,
				duration: clip.duration,
				frameStep: (TICKS_PER_SECOND * denominator) / numerator,
			}),
			signal,
		});
		for (const [index, frame] of frames.entries()) {
			await upload({
				file: frame,
				name: `Original clip frame ${index + 1}.jpg`,
			});
		}
	} else {
		for (const file of files) await upload({ file, name: file.name });
	}
	check();
	const direction = prompt.trim();
	const { job } = await api<{ job: DirectorJob }>({
		projectId: original.projectId,
		action: "prepare",
		signal,
		data: {
			request: {
				projectId: original.projectId,
				referenceIds,
				...(generateImage
					? {
							kind: "storyboard",
							model: REPLACE_IMAGE_MODEL,
							referenceImage: true,
							prompt: `Create one cinematic reference still for this replacement shot. Return one frame without text, a grid or annotations.\n\n${direction}`,
						}
					: {
							kind: "video",
							model: REPLACE_VIDEO_MODEL,
							duration,
							resolution,
							aspectRatio,
							replacement: { ...target, ...plan, mode },
							prompt:
								mode === "refine"
									? `Recreate this shot using the original frames in chronological order as visual references. Preserve characters, setting, style, lighting and camera continuity except for the requested edit.\n\n${direction}`
									: direction,
						}),
			},
		},
	});
	check();
	return job;
}

export function applyReplacement({
	editor,
	job,
	mediaId,
}: {
	editor: EditorCore;
	job: DirectorJob;
	mediaId: string;
}) {
	const target = job.replacement;
	const original = scope(editor);
	if (!target || original.projectId !== job.projectId)
		throw new Error("Open the original project to replace this clip");
	if (editor.scenes.getActiveSceneOrNull()?.id !== target.sceneId)
		throw new Error("Open the original scene to replace this clip");
	const clip = editor.timeline
		.getTrackById({ trackId: target.trackId })
		?.elements.find((item) => item.id === target.elementId);
	if (clip?.type === "video" && clip.mediaId === mediaId) return false;
	const { sceneId, trackId, elementId, anchor } = target;
	editor.command.invokeCanonicalControl({
		...original,
		capabilityId: "timeline.classic.replace.apply",
		input: { target: { sceneId, trackId, elementId }, anchor, mediaId },
	});
	return true;
}
