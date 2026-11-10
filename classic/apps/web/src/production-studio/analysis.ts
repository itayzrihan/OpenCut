import type { EditorCore } from "@/core";
import { offerEditingAgentDraft } from "@/editor-agent/draft";
import { productionScope } from "./client";

/** Populates the human's composer; this never starts inference or paid work. */
export function requestVideoAnalysis({
	editor,
	mediaId,
	sourceName,
}: {
	editor: EditorCore;
	mediaId: string;
	sourceName: string;
}): void {
	const { projectId } = productionScope(editor);
	const media = editor.media
		.getAssets()
		.find((item) => item.id === mediaId && item.type === "video");
	if (!media)
		throw new Error("Choose a video already imported into this project");
	offerEditingAgentDraft({
		projectId,
		text: `Analyze the canonical source video ${JSON.stringify(sourceName)} (mediaId ${JSON.stringify(mediaId)}). First read project.production.read and the production-video-analysis skill. Use project.production.video.inspect for up to eight actual source timestamps per call, including the opening, setup/payoff changes and ending. Inspect the returned frame artifacts; obtain the existing timed transcript/audio evidence using discovered supported capabilities before making speech, delivery or humor claims. Do not treat the media ID or filename as inspected video. Separate facts from interpretation for hook, humor, CTA, visuals, pacing and audio; explicitly limit conclusions to reviewed coverage. Store the evidence-backed report with project.production.edit recordAnalysis and real artifact IDs, then propose concrete edits. Do not generate or publish any media.`,
	});
}
