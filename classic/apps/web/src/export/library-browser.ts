import { z } from "zod";
import { EditorSessionClient } from "@/editor-agent/session-client";
import { storageService } from "@/services/storage/service";
import { canonicalMediaBindings } from "@/core/canonical-classic-session";
import type { SerializedProject } from "@/services/storage/types";
import type { ExportOptions } from "@/export";
import type { RenderQueueView } from "./queue/types";
import { browserRenderRequest } from "./queue/browser";
import { planSavedExport } from "./library-snapshot";

const options = z.custom<ExportOptions>();
const base = {
	projectId: z.string(),
	sceneId: z.string().optional(),
	options: options.optional(),
};
const schema = z.discriminatedUnion("action", [
	z.object({ ...base, action: z.literal("inspect") }),
	z.object({
		...base,
		action: z.literal("enqueue"),
		id: z.string().uuid(),
		expectedStorageRevision: z.number(),
		delivery: z.enum(["queue", "direct"]),
		destinationName: z.string().optional(),
	}),
]);
export async function browserProjectExportRequest(body: unknown) {
	const input = schema.parse(body);
	const accountId = window.__opencutAccountId;
	if (!accountId) throw Error("Sign in before opening the export queue");
	if (input.action === "enqueue") {
		const queue = (await browserRenderRequest()) as RenderQueueView;
		const existing = queue.jobs.find((job) => job.id === input.id);
		if (existing) {
			if (
				existing.projectId !== input.projectId ||
				existing.delivery !== input.delivery ||
				(existing.delivery === "direct" &&
					existing.destinationName !== input.destinationName)
			)
				throw Error("Export identity conflict");
			return existing;
		}
	}
	const session = await new EditorSessionClient({
		projectId: input.projectId,
		accountId,
	}).read();
	if (
		input.action === "enqueue" &&
		session.storageRevision !== input.expectedStorageRevision
	)
		throw Error(
			"This project changed since opening Export. Refresh its saved snapshot and try again.",
		);
	const project = (session.saved?.project ??
		session.legacyProject) as SerializedProject | null;
	if (!project) throw Error("Saved project is unavailable");
	const assets = await storageService.loadAllMediaAssets({
		projectId: input.projectId,
	});
	if (accountId !== window.__opencutAccountId)
		throw Error("The export account changed");
	const { info, snapshot } = await planSavedExport({
		...input,
		project,
		mediaAssets: canonicalMediaBindings(assets),
		storageRevision: session.storageRevision,
		editorRevision: session.saved?.editorRevision,
	});
	if (input.action === "inspect") return info;
	const state = (await browserRenderRequest({
		action: "enqueue",
		id: input.id,
		projectId: input.projectId,
		sceneId: info.sceneId,
		snapshot,
		sourceRevision: info.sourceRevision,
		options: info.options,
		delivery: input.delivery,
		destinationName: input.destinationName,
	})) as RenderQueueView;
	return state.jobs.find((job) => job.id === input.id)!;
}
