import { toast } from "@/i18n/toast";
import type { EditorCore } from "@/core";
import { getClipAudioTiming } from "@/media/audio-sync";
import { resolveUnifiedAnglesAudioAsset } from "@/media/unified-angles";
import type { MediaAsset } from "@/media/types";
import {
	assertLocalDriveWriteScope,
	captureLocalDriveWriteScope,
} from "@/services/local-drive/client";
import { storageService } from "@/services/storage/service";
import { TICKS_PER_SECOND } from "@/wasm";
import type { UploadAudioElement } from "../types";

const sampleRate = 48_000;
const active = new Set<string>();
const tracks = [
	["background", "Music + effects"],
	["dialogue", "Speech"],
	["music", "Music"],
	["effects", "Effects"],
] as const;

function fingerprint(element: UploadAudioElement) {
	return JSON.stringify([
		element.mediaId,
		element.startTime,
		element.duration,
		element.trimStart,
		element.trimEnd,
		element.retime,
		element.params.audioSyncOffset,
		element.params.sourceAudioOffsetSeconds,
	]);
}

export async function separateDialogue({
	editor,
	trackId,
	element,
	mode,
}: {
	editor: EditorCore;
	trackId: string;
	element: UploadAudioElement;
	mode: "remove" | "split";
}) {
	const projectId = editor.project.getActiveOrNull()?.metadata.id;
	const sceneId = editor.scenes.getActiveSceneOrNull()?.id;
	const accountId = window.__opencutAccountId;
	if (!projectId || !sceneId || !accountId)
		throw new Error("Open a project before separating speech");
	const scope = captureLocalDriveWriteScope({ projectId, accountId });
	const expected = fingerprint(element);
	const assertCurrent = () => {
		assertLocalDriveWriteScope({ projectId, scope });
		if (
			editor.project.getActiveOrNull()?.metadata.id !== projectId ||
			editor.scenes.getActiveSceneOrNull()?.id !== sceneId ||
			window.__opencutAccountId !== accountId
		)
			throw new Error("The project changed during speech separation");
		const current = editor.timeline.getElementsWithTracks({
			elements: [{ trackId, elementId: element.id }],
		})[0]?.element;
		if (
			current?.type !== "audio" ||
			current.sourceType !== "upload" ||
			fingerprint(current) !== expected
		)
			throw new Error(
				"The audio clip changed during speech separation. Select it again.",
			);
	};
	assertCurrent();
	const mediaMap = new Map(
		editor.media.getAssets().map((asset) => [asset.id, asset]),
	);
	const asset = mediaMap.get(element.mediaId);
	const source = asset && resolveUnifiedAnglesAudioAsset({ asset, mediaMap });
	if (!source || source.missing)
		throw new Error("Relink the source media before separating speech");
	const rate = Math.min(5, Math.max(0.01, element.retime?.rate ?? 1));
	const timing = getClipAudioTiming(element);
	const frames = Math.ceil(
		(element.duration / TICKS_PER_SECOND) * rate * sampleRate,
	);
	const leadingFrames = Math.max(
		0,
		Math.round(
			(timing.startTime - element.startTime / TICKS_PER_SECOND) *
				rate *
				sampleRate,
		),
	);
	if (frames <= 0 || frames > 30 * sampleRate || leadingFrames >= frames)
		throw new Error("Select a clip with up to 30 seconds of source audio");
	const key = `${accountId}:${projectId}:${element.id}`;
	if (active.has(key)) return;
	active.add(key);
	const controller = new AbortController();
	const toastId = toast.loading("Separating speech locally with DBS-TIGER…", {
		cancel: { label: "Cancel", onClick: () => controller.abort() },
	});
	const imported: MediaAsset[] = [];
	const staged: string[] = [];
	let published = false;
	try {
		const response = await fetch("/api/audio-separation", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-OpenCut-Account": accountId,
			},
			body: JSON.stringify({
				projectId,
				mediaId: source.id,
				sourceStart: timing.trimStart,
				frames,
				leadingFrames,
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			const body: { error?: string } = await response.json().catch(() => ({}));
			throw new Error(body.error || "DBS-TIGER could not separate the clip");
		}
		const stems = await response.formData();
		assertCurrent();
		for (const [key, label] of mode === "split" ? tracks.slice(0, 2) : tracks) {
			const blob = stems.get(key);
			if (
				!(blob instanceof File) ||
				blob.type !== "audio/wav" ||
				blob.size !== 44 + frames * 8
			)
				throw new Error(
					"DBS-TIGER returned an audio track that does not match the clip",
				);
			const file = new File([blob], `${element.name} - ${label}.wav`, {
				type: "audio/wav",
			});
			imported.push({
				id: crypto.randomUUID(),
				type: "audio",
				name: file.name,
				mimeType: file.type,
				file,
				url: URL.createObjectURL(file),
				duration: frames / sampleRate,
				hasAudio: true,
			});
		}
		const publish = editor.command.prepareClassicMediaImport({
			projectId,
			assets: imported,
			afterRegister: () => {
				assertCurrent();
				editor.command.editClassicSourceAudio({
					trackId,
					elementId: element.id,
					mediaId: imported[0].id,
					sourceOffset: 0,
					...(mode === "split"
						? {
								action: "splitDialogueStems",
								dialogueMediaId: imported[1].id,
							}
						: { action: "replaceWithStem" }),
				});
				return undefined;
			},
		});
		for (const mediaAsset of imported) {
			controller.signal.throwIfAborted();
			assertCurrent();
			staged.push(mediaAsset.id);
			await storageService.saveMediaAsset({
				projectId,
				mediaAsset,
				scope: { ...scope, signal: controller.signal },
			});
		}
		controller.signal.throwIfAborted();
		publish();
		published = true;
		toast.success("Speech separation complete", {
			description:
				mode === "split"
					? "Speech is on one track. Music and effects are on the other. The tracks are aligned."
					: "Listen to the result on the timeline. The separated tracks are also available in Media.",
		});
	} catch (error) {
		if (!controller.signal.aborted) throw error;
	} finally {
		toast.dismiss(toastId);
		if (!published) {
			for (const media of imported)
				if (media.url) URL.revokeObjectURL(media.url);
			await Promise.allSettled(
				staged.map((id) =>
					storageService.deleteMediaAsset({ projectId, id, scope }),
				),
			);
		}
		active.delete(key);
	}
}
