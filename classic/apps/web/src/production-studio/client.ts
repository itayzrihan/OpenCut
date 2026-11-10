/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Canonical Rust schemas validate every persisted workspace and mutation. */
import type { EditorCore } from "@/core";
import { uploadDirectorReference } from "@/generative/client";
import type { ProductionProjection, ReferenceSlot } from "./types";

export function productionScope(editor: EditorCore) {
	const projectId = editor.project.getActiveOrNull()?.metadata.id;
	const accountId = window.__opencutAccountId ?? "local";
	if (!projectId)
		throw new Error("Open a project to use the production workspace");
	return { projectId, accountId };
}
export function readProduction(editor: EditorCore): ProductionProjection {
	return editor.command.readProduction(
		productionScope(editor),
	) as ProductionProjection;
}
export function editProduction({
	editor,
	change,
	accountId,
	projectId,
}: {
	editor: EditorCore;
	change: Record<string, unknown>;
	accountId: string;
	projectId: string;
}): void {
	editor.command.invokeCanonicalControl({
		accountId,
		projectId,
		capabilityId: "project.production.edit",
		input: { change },
	});
}
/** Files are existing account-owned references; the canonical slot edit appends
 * one version and cannot regenerate or replace its siblings. */
export async function attachProductionReference({
	editor,
	slot,
	blob,
	name,
	source,
	caption,
	signal,
}: {
	editor: EditorCore;
	slot: ReferenceSlot;
	blob: Blob;
	name: string;
	source: "uploaded" | "generated";
	caption: string;
	signal: AbortSignal;
}) {
	const { projectId, accountId } = productionScope(editor);
	const check = () => {
		signal.throwIfAborted();
		if (
			editor.project.getActiveOrNull()?.metadata.id !== projectId ||
			(window.__opencutAccountId ?? "local") !== accountId
		)
			throw new Error("The production account or project changed");
		const current = readProduction(editor).workspace.referenceSlots.find(
			(item) => item.id === slot.id,
		);
		if (!current || current.slotVersion !== slot.slotVersion)
			throw new Error(
				"This reference slot changed. Review it before attaching another version.",
			);
	};
	check();
	if (
		!["image/png", "image/jpeg", "image/webp"].includes(blob.type) ||
		!blob.size ||
		blob.size > 16 * 1024 * 1024
	)
		throw new Error("Choose a PNG, JPEG or WebP image up to 16 MiB");
	const reference = await uploadDirectorReference({
		projectId,
		accountId,
		file: blob,
		name,
		signal,
	});
	check();
	editor.command.invokeCanonicalControl({
		projectId,
		accountId,
		capabilityId: "project.generative.edit",
		input: { change: { type: "reference", reference } },
	});
	check();
	editProduction({
		editor,
		projectId,
		accountId,
		change: {
			type: "addReferenceVersion",
			slotId: slot.id,
			expectedSlotVersion: slot.slotVersion,
			referenceId: reference.id,
			caption,
			source,
		},
	});
}
export function formatProductionTime(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
