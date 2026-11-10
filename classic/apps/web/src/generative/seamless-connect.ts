import { z } from "zod";
import type { EditorCore } from "@/core";
import type {
	TimelineElement,
	TimelineTrack,
	VideoElement,
} from "@/timeline/types";
import { TICKS_PER_SECOND } from "@/wasm";
import { api, canonical, scope, uploadDirectorReference } from "./client";
import type { DirectorJob, SeamlessTarget } from "./types";
import type { VideoGenerationModel } from "./seamless-models";

type Target = Omit<SeamlessTarget, "anchor">;
const planSchema = z.object({
	anchor: z.string(),
	cutTime: z.number(),
	rightStart: z.number(),
});
export const defaultSeamlessPrompt =
	"Create a natural, continuous transition between the two supplied frames. Preserve the subjects, lighting, and setting. Use coherent motion and match the supplied endpoints.";

export type SeamlessPair = {
	trackId: string;
	left: VideoElement;
	right: VideoElement;
};

export function getSeamlessPair(
	entries: { track: TimelineTrack; element: TimelineElement }[],
): SeamlessPair | null {
	if (entries.length !== 2) return null;
	const [first, second] = entries;
	if (
		first.element.type !== "video" ||
		second.element.type !== "video" ||
		first.track.id !== second.track.id
	)
		return null;
	const [left, right] =
		first.element.startTime <= second.element.startTime
			? [first.element, second.element]
			: [second.element, first.element];
	return { trackId: first.track.id, left, right };
}

export function planSeamless({
	editor,
	target,
}: {
	editor: EditorCore;
	target: Target;
}) {
	if (editor.scenes.getActiveSceneOrNull()?.id !== target.sceneId)
		throw new Error("Open the original scene to connect these clips");
	return planSchema.parse(
		editor.command.invokeCanonicalControl({
			...scope(editor),
			capabilityId: "timeline.classic.bridge.plan",
			input: { ...target },
		}),
	);
}

export function nearestVideoAspect({
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

export async function prepareSeamless({
	editor,
	trackId,
	left,
	right,
	model,
	duration,
	resolution,
	prompt,
	signal,
}: {
	editor: EditorCore;
	trackId: string;
	left: VideoElement;
	right: VideoElement;
	model: VideoGenerationModel;
	duration: number;
	resolution: string;
	prompt: string;
	signal: AbortSignal;
}) {
	const original = scope(editor);
	const project = editor.project.getActiveForScene();
	const sceneId = editor.scenes.getActiveSceneOrNull()?.id;
	if (!project || !sceneId) throw new Error("Open a scene to connect clips");
	const target = { sceneId, trackId, leftId: left.id, rightId: right.id };
	const { anchor } = planSeamless({ editor, target });
	const clips = editor.timeline.getTrackById({ trackId })?.elements;
	const outgoing = clips?.find((clip) => clip.id === target.leftId);
	const incoming = clips?.find((clip) => clip.id === target.rightId);
	if (outgoing?.type !== "video" || incoming?.type !== "video")
		throw new Error("The selected videos are no longer on the timeline");
	const check = () => {
		signal.throwIfAborted();
		const active = scope(editor);
		if (
			active.projectId !== original.projectId ||
			active.accountId !== original.accountId ||
			planSeamless({ editor, target }).anchor !== anchor
		)
			throw new Error(
				"The source clips changed. Prepare the connection again.",
			);
	};
	const first = await editor.renderer.captureVideoBoundary({
		clip: outgoing,
		edge: "last",
	});
	if (!first.success) throw new Error(first.error);
	check();
	const last = await editor.renderer.captureVideoBoundary({
		clip: incoming,
		edge: "first",
	});
	if (!last.success) throw new Error(last.error);
	check();
	const referenceIds = [];
	for (const [name, frame] of [
		["Outgoing last frame.jpg", first.blob],
		["Incoming first frame.jpg", last.blob],
	] as const) {
		const reference = await uploadDirectorReference({
			...original,
			file: frame,
			name,
			signal,
		});
		referenceIds.push(reference.id);
		check();
	}
	const { job } = await api<{ job: DirectorJob }>({
		projectId: original.projectId,
		action: "prepare",
		signal,
		data: {
			request: {
				projectId: original.projectId,
				kind: "video",
				model: model.id,
				duration,
				resolution,
				aspectRatio: nearestVideoAspect({
					...project.settings.canvasSize,
					model,
				}),
				prompt: prompt.trim() || defaultSeamlessPrompt,
				referenceIds,
				seamless: { ...target, anchor },
			},
		},
	});
	check();
	return job;
}

export function insertSeamless({
	editor,
	job,
	mediaId,
}: {
	editor: EditorCore;
	job: DirectorJob;
	mediaId: string;
}) {
	if (!job.seamless || scope(editor).projectId !== job.projectId)
		throw new Error("Open the original project to insert the connection");
	if (editor.scenes.getActiveSceneOrNull()?.id !== job.seamless.sceneId)
		throw new Error("Open the original scene to connect these clips");
	const tracks = editor.scenes.getActiveScene().tracks;
	const track = [tracks.main, ...tracks.overlay].find(
		(t) => t.id === job.seamless?.trackId,
	);
	if (
		track?.elements.some(
			(clip) => clip.type === "video" && clip.mediaId === mediaId,
		)
	)
		return false;
	const asset = editor.media
		.getAssets()
		.find((item) => item.id === mediaId && item.type === "video");
	const sourceTicks = Math.round((asset?.duration ?? 0) * TICKS_PER_SECOND);
	const requestedTicks = Math.round((job.duration ?? 0) * TICKS_PER_SECOND);
	if (!sourceTicks || !requestedTicks)
		throw new Error("The generated video has no usable duration");
	editor.command.invokeCanonicalControl({
		...scope(editor),
		capabilityId: "timeline.classic.bridge.insert",
		input: {
			...job.seamless,
			mediaId,
			duration: Math.min(sourceTicks, requestedTicks),
		},
	});
	return true;
}

export type SeamlessSelection = { pairs: SeamlessPair[] };
/** Selection only; canonical pair planning validates adjacency and locked layers. */
export function getSeamlessSelection(
	entries: { track: TimelineTrack; element: TimelineElement }[],
): SeamlessSelection | null {
	if (entries.length < 2 || entries.length > 33) return null;
	const ordered = [...entries].sort(
		(a, b) => a.element.startTime - b.element.startTime,
	);
	const pairs: SeamlessPair[] = [];
	for (let index = 1; index < ordered.length; index++) {
		const pair = getSeamlessPair([ordered[index - 1], ordered[index]]);
		if (!pair) return null;
		pairs.push(pair);
	}
	return { pairs };
}
export function insertSeamlessBatch({
	editor,
	jobs,
}: {
	editor: EditorCore;
	jobs: DirectorJob[];
}) {
	const current = scope(editor);
	const sceneId = editor.scenes.getActiveSceneOrNull()?.id;
	const document = canonical({ editor }).document;
	if (
		!jobs.length ||
		jobs.length > 10 ||
		!sceneId ||
		jobs.some(
			(j) =>
				j.projectId !== current.projectId ||
				!j.seamless ||
				j.seamless.sceneId !== sceneId ||
				j.status !== "ready",
		)
	)
		throw new Error("Open the original scene after every batch video is ready");
	const batchIds = new Set(jobs.map((j) => j.batchId));
	if (batchIds.size !== 1 || !jobs[0].batchId)
		throw new Error("Select one complete Seamless batch");
	const cuts = jobs.map((job) => {
		const mediaId = document.jobs.find((j) => j.id === job.id)?.mediaId;
		const asset = editor.media.getAssets().find((a) => a.id === mediaId);
		if (!mediaId || !asset?.duration)
			throw new Error("Wait for every generated video to import into Media");
		return {
			...job.seamless!,
			mediaId,
			duration: Math.min(
				Math.round(asset.duration * TICKS_PER_SECOND),
				Math.round((job.duration ?? 0) * TICKS_PER_SECOND),
			),
		};
	});
	const tracks = editor.scenes.getActiveScene().tracks;
	const clips = [tracks.main, ...tracks.overlay].flatMap<TimelineElement>(
		(t) => t.elements,
	);
	const inserted = cuts.filter((c) =>
		clips.some((e) => e.type === "video" && e.mediaId === c.mediaId),
	);
	if (inserted.length === cuts.length) return false;
	if (inserted.length)
		throw new Error(
			"Some connections were already inserted. Undo those insertions before applying the complete batch.",
		);
	editor.command.invokeCanonicalControl({
		...current,
		capabilityId: "timeline.classic.bridge.batch.insert",
		input: {
			sceneId,
			cuts: cuts.map((c) => ({
				trackId: c.trackId,
				leftId: c.leftId,
				rightId: c.rightId,
				anchor: c.anchor,
				mediaId: c.mediaId,
				duration: c.duration,
			})),
		},
	});
	return true;
}
