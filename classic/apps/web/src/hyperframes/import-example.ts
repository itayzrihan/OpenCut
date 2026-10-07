/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The canonical registry validates the inspection projection. */
import type { EditorCore } from "@/core";
import { loadCanonicalRuntime } from "@/core/load-canonical-runtime";
import {
	importHyperframesFolder,
	type HyperframesImportProgress,
} from "./import-folder";
import type { HyperframesInspection, HyperframesSource } from "./types";
import { TICKS_PER_SECOND } from "@/wasm";

/** Bounded package IO. Canonical source reads verify every pinned file; the
 * existing import journal owns resource staging, commit, undo and persistence. */
export async function importHyperframesExample({
	editor,
	projectId,
	id,
	upstreamCommit,
	signal,
	onProgress,
}: {
	editor: EditorCore;
	projectId: string;
	id: string;
	upstreamCommit: string;
	signal: AbortSignal;
	onProgress?: (progress: HyperframesImportProgress) => void;
}) {
	const accountId =
		typeof window === "undefined" ? null : window.__opencutAccountId;
	const sceneId = editor.scenes.getActiveSceneOrNull()?.id;
	const startSeconds = editor.playback.getCurrentTime() / TICKS_PER_SECOND;
	const assertTarget = () => {
		signal.throwIfAborted();
		if (
			!sceneId ||
			editor.project.getActiveOrNull()?.metadata.id !== projectId ||
			editor.scenes.getActiveSceneOrNull()?.id !== sceneId ||
			(typeof window === "undefined" ? null : window.__opencutAccountId) !==
				accountId
		)
			throw new Error("The reference import account, project or scene changed");
	};
	assertTarget();
	const manifest = await editor.command.readHyperframesExample({
		projectId,
		id,
		upstreamCommit,
	});
	const prepared = manifest.item.prepared;
	if (!prepared) throw new Error("This reference has no prepared package yet");
	const source: HyperframesSource = {
		entryFile: prepared.entryFile,
		files: {},
		resourceAssetIds: {},
	};
	for (const [index, file] of prepared.files.entries()) {
		let offset = 0;
		let text = "";
		for (;;) {
			assertTarget();
			const page = await editor.command.readHyperframesExampleSource({
				projectId,
				id,
				upstreamCommit,
				filePath: `@prepared/${file.path}`,
				expectedSha256: file.sha256,
				offset,
				limit: 12000,
				signal,
			});
			text += page.text;
			if (page.nextOffset === null) break;
			offset = page.nextOffset;
		}
		source.files[file.path] = text;
		onProgress?.({
			phase: "checking",
			completed: index + 1,
			total: prepared.files.length,
		});
	}
	const runtime = await loadCanonicalRuntime();
	try {
		assertTarget();
		const inspection = runtime.invokeSync(
			"hyperframes.project.inspect",
			{ source },
			null,
		).result.data as HyperframesInspection;
		return await importHyperframesFolder({
			editor,
			folder: { name: manifest.item.title, source, resources: [], inspection },
			startSeconds,
			signal,
			onProgress,
		});
	} finally {
		runtime.free();
	}
}
