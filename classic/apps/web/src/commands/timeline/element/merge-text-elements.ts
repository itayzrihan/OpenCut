import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import { mergeTextElements } from "@/text/text-layer-utils";
import type { SceneTracks, TimelineTrack } from "@/timeline";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import {
	removeTextLayerWordsFromCaptionSource,
	syncTextLayerWordsIntoCaptionSource,
} from "@/subtitles/caption-source-sync";

export class MergeTextElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly elements: { trackId: string; elementId: string }[];
	private readonly mode: "single-line" | "multiline";

	constructor({
		elements,
		mode = "single-line",
	}: {
		elements: { trackId: string; elementId: string }[];
		mode?: "single-line" | "multiline";
	}) {
		super();
		this.elements = elements;
		this.mode = mode;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const textItems = this.elements.flatMap((ref) => {
			const track = findTrackInSceneTracks({
				tracks: this.savedState!,
				trackId: ref.trackId,
			});
			const element = track?.elements.find(
				(candidate) => candidate.id === ref.elementId,
			);
			if (!track || !element || element.type !== "text") return [];
			return [
				{
					trackId: track.id,
					element,
				},
			];
		});
		if (textItems.length !== this.elements.length) return undefined;

		const mergeResult = mergeTextElements({ items: textItems, mode: this.mode });
		if (!mergeResult) return undefined;

		const removeKeys = new Set(
			mergeResult.removeElements.map(
				({ trackId, elementId }) => `${trackId}:${elementId}`,
			),
		);
		const targetKey = `${mergeResult.targetTrackId}:${mergeResult.targetElementId}`;
		const updateTrack = <TTrack extends TimelineTrack>(
			track: TTrack,
		): TTrack => {
			const elements = track.elements.flatMap((element) => {
				const key = `${track.id}:${element.id}`;
				if (key === targetKey) {
					return [mergeResult.mergedElement];
				}
				if (removeKeys.has(key)) {
					return [];
				}
				return [element];
			});

			return {
				...track,
				elements,
			} as TTrack;
		};
		let updatedTracks: SceneTracks = {
			...this.savedState,
			overlay: this.savedState.overlay.map((track) => updateTrack(track)),
			main: updateTrack(this.savedState.main),
			audio: this.savedState.audio.map((track) => updateTrack(track)),
		};
		updatedTracks = removeTextLayerWordsFromCaptionSource({
			tracks: updatedTracks,
			elements:
				this.mode === "multiline"
					? [
							{
								trackId: mergeResult.targetTrackId,
								elementId: mergeResult.targetElementId,
							},
							...mergeResult.removeElements,
						]
					: mergeResult.removeElements,
		});
		updatedTracks = syncTextLayerWordsIntoCaptionSource({
			tracks: updatedTracks,
			elements: [
				{
					trackId: mergeResult.targetTrackId,
					elementId: mergeResult.targetElementId,
				},
			],
		});

		editor.timeline.updateTracks(updatedTracks);
		return createElementSelectionResult([
			{
				trackId: mergeResult.targetTrackId,
				elementId: mergeResult.targetElementId,
			},
		]);
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
