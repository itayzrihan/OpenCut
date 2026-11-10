import type { EditorCore } from "@/core";
import { generateProductionReference as generateReviewedImage } from "@/ai/production-image";
import type { ProductionGenerationRequest } from "./types";
import { productionScope } from "./client";

export async function productionGenerationId({
	accountId,
	projectId,
	slotId,
	slotVersion,
	prompt,
	referenceIds,
	provider,
	model,
}: {
	accountId: string;
	projectId: string;
	slotId: string;
	slotVersion: number;
	prompt: string;
	referenceIds: string[];
	provider: "codex" | "openrouter";
	model?: string;
}): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify({
				accountId,
				projectId,
				slotId,
				slotVersion,
				prompt,
				referenceIds,
				provider,
				model: provider === "openrouter" ? model : null,
			}),
		),
	);
	return (
		"production-" +
		Array.from(new Uint8Array(digest), (value) =>
			value.toString(16).padStart(2, "0"),
		).join("")
	);
}

/** Called only after the user sees and confirms the exact reference prompt. */
export async function generateProductionReference({
	editor,
	...input
}: ProductionGenerationRequest & { editor: EditorCore }): Promise<{
	blob: Blob;
	mimeType: string;
}> {
	const { projectId, accountId } = productionScope(editor);
	const check = () => {
		input.signal.throwIfAborted();
		if (
			(window.__opencutAccountId ?? "local") !== accountId ||
			editor.project.getActiveOrNull()?.metadata.id !== projectId
		)
			throw new Error("The image generation account or project changed");
	};
	check();
	const request = {
		prompt: input.prompt,
		referenceIds: input.referenceIds,
		operationId: input.operationId,
		projectId,
		provider: input.provider,
		model: input.model,
		confirmed: true as const,
		signal: input.signal,
	};
	const output = await generateReviewedImage(request);
	check();
	return output;
}
