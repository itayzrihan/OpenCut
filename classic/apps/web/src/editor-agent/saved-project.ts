/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The host's saved archive is validated again by Rust restore before editing. */
import {
	EditorSessionClient,
	type EditorSessionBundle,
} from "./session-client";
import { CanonicalClassicSession } from "@/core/canonical-classic-session";
import { loadCanonicalRuntime } from "@/core/load-canonical-runtime";
import { deserializeProject } from "@/services/storage/service";
import type { TProject } from "@/project/types";

/** Library metadata edits use a short-lived canonical runtime and the same
 * ownership contract; they cannot replace an open editor's saved document. */
export async function renameSavedEditorProject({
	projectId,
	name,
}: {
	projectId: string;
	name: string;
}): Promise<TProject | null> {
	const accountId = window.__opencutAccountId ?? "local";
	const storage = new EditorSessionClient({ accountId, projectId });
	const read = await storage.read();
	if (!read.saved) return null;
	const acquired = await storage.acquire({
		expectedGeneration: read.generation,
	});
	let session: CanonicalClassicSession | null = null;
	try {
		const bundle = acquired.saved!.bundle as EditorSessionBundle;
		const runtime = await loadCanonicalRuntime();
		session = new CanonicalClassicSession({ runtime, projectId });
		session.restore(bundle.archive);
		if (bundle.artifacts)
			session.restoreConversationArtifacts({
				accountId,
				archive: bundle.artifacts,
			});
		if (bundle.conversation)
			session.restoreConversation({ accountId, archive: bundle.conversation });
		if (bundle.agentCheckpoint)
			session.restoreAgentCheckpoint({
				accountId,
				checkpoint: bundle.agentCheckpoint,
			});
		const classic = session.read();
		classic.document.metadata.name = name;
		classic.document.metadata.updatedAt = new Date().toISOString();
		runtime.invokeSync(
			"project.classic.commit",
			{ projectId, expectedRevision: session.status().revision, classic },
			null,
		);
		await storage.save(() => ({
			archive: session!.archive(),
			agentCheckpoint: session!.captureAgentCheckpoint(),
			thumbnail: bundle.thumbnail,
			conversation: session!.readConversation(accountId) ?? undefined,
			artifacts: session!.captureConversationArtifacts(accountId),
		}));
		return deserializeProject({
			...session.read().document,
			metadata: {
				...session.read().document.metadata,
				thumbnail: bundle.thumbnail,
			},
		});
	} finally {
		session?.dispose();
		await storage.release();
	}
}
