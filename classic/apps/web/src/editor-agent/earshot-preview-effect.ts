import type { EditorCore } from "@/core";
import type {
	EditingAgentHostEffect,
	EditingAgentHostResult,
} from "@/core/agent-protocol";
import { resolveEarshotBuffer } from "@/earshot/audio";
import { validateEarshotSpec } from "@/earshot/types";
import { z } from "zod";

/** Platform IO only. The canonical capability chooses the window, measures
 * the returned PCM and creates the bounded artifact. No project mutation. */
export async function performEarshotPreviewEffect({
	effect,
	editor,
	accountId,
	signal,
}: {
	effect: EditingAgentHostEffect;
	editor: EditorCore;
	accountId: string;
	signal: AbortSignal;
}): Promise<EditingAgentHostResult> {
	try {
		if (effect.adapter !== "earshotPreview")
			throw new Error("Unsupported Earshot adapter");
		const input = z
			.object({
				projectId: z.string(),
				expectedRevision: z.number().int().nonnegative(),
				procedural: z.unknown(),
				startFrame: z.number().int().min(0).max(1440000),
				frames: z.number().int().min(960).max(384000),
			})
			.strict()
			.parse(effect.request);
		const spec = validateEarshotSpec(input.procedural);
		if (input.startFrame + input.frames > Math.round(spec.duration * 48000))
			throw new Error("Preview window exceeds source");
		const assertScope = () => {
			signal.throwIfAborted();
			if (
				(window.__opencutAccountId ?? "local") !== accountId ||
				editor.project.getActiveOrNull()?.metadata.id !== effect.projectId ||
				input.projectId !== effect.projectId ||
				editor.command.getCanonicalRevision() !== input.expectedRevision
			)
				throw new Error("Earshot preview account, project or revision changed");
		};
		assertScope();
		const context = new OfflineAudioContext(1, 1, 48000);
		const buffer = await resolveEarshotBuffer({ spec, context, signal });
		assertScope();
		if (
			buffer.sampleRate !== 48000 ||
			buffer.length !== Math.round(spec.duration * 48000) ||
			buffer.numberOfChannels < 1 ||
			buffer.numberOfChannels > 2
		)
			throw new Error("Invalid Earshot PCM output");
		const channels = Array.from(
			{ length: buffer.numberOfChannels },
			(_, index) => buffer.getChannelData(index),
		);
		const pcm = new Uint8Array(input.frames * channels.length * 2);
		const view = new DataView(pcm.buffer);
		for (let frame = 0; frame < input.frames; frame++) {
			for (let channel = 0; channel < channels.length; channel++) {
				const sample = channels[channel][input.startFrame + frame];
				if (!Number.isFinite(sample) || Math.abs(sample) > 1.001)
					throw new Error("Invalid Earshot sample");
				view.setInt16(
					(frame * channels.length + channel) * 2,
					Math.round(
						Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767),
					),
					true,
				);
			}
		}
		let binary = "";
		for (let offset = 0; offset < pcm.length; offset += 8192)
			binary += String.fromCharCode(...pcm.subarray(offset, offset + 8192));
		assertScope();
		return {
			type: "success",
			data: { channels: channels.length, pcm16Base64: btoa(binary) },
		};
	} catch (error) {
		return {
			type: "rejected",
			message:
				error instanceof Error ? error.message : "Earshot preview failed",
		};
	}
}
