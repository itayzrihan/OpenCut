/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Canonical inspection validates the preserved source contract. */
import { loadCanonicalRuntime } from "@/core/load-canonical-runtime";
import type { HyperframesImportRecovery } from "./import-recovery-types";
import type { HyperframesFolder, PreparedHyperframesFolder } from "./folder";
import type { HyperframesInspection } from "./types";

export async function prepareRecoveredFolder({
	recovery,
	selected,
	signal,
}: {
	recovery: HyperframesImportRecovery;
	selected?: HyperframesFolder | null;
	signal?: AbortSignal;
}): Promise<PreparedHyperframesFolder> {
	const { draft, readyAssetIds } = recovery;
	signal?.throwIfAborted();
	if (selected) {
		for (const [path, text] of Object.entries(draft.source.files)) {
			signal?.throwIfAborted();
			const file = selected.files.get(path);
			if (
				!file ||
				new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
					await file.arrayBuffer(),
				) !== text
			)
				throw new Error(`This folder does not match the saved import: ${path}`);
		}
	}
	const resources = draft.resources.map((asset) => {
		if (readyAssetIds.includes(asset.id))
			return { ...asset, storageKind: "copied" as const };
		const path = Object.entries(draft.source.resourceAssetIds).find(
			([, id]) => id === asset.id,
		)?.[0];
		const file = path ? selected?.files.get(path) : undefined;
		if (!file)
			throw new Error(
				"Choose the original project folder to copy the remaining files",
			);
		if (file.size !== asset.size || file.lastModified !== asset.lastModified)
			throw new Error(`The original file changed: ${path}`);
		return {
			...asset,
			storageKind: "copied" as const,
			file: new File([file], asset.fileName ?? file.name, {
				type: asset.mimeType,
				lastModified: file.lastModified,
			}),
		};
	});
	const runtime = await loadCanonicalRuntime();
	try {
		signal?.throwIfAborted();
		const receipt = runtime.invokeSync(
			"hyperframes.project.inspect",
			{ source: draft.source },
			undefined,
		) as { result: { data: HyperframesInspection } };
		return {
			name: draft.name,
			source: draft.source,
			inspection: receipt.result.data,
			resources,
		};
	} finally {
		runtime.free();
	}
}

export async function withImportLock<T>({
	accountId,
	projectId,
	uploadToken,
	resuming,
	run,
}: {
	accountId: string;
	projectId: string;
	uploadToken: string;
	resuming: boolean;
	run: () => Promise<T>;
}): Promise<T> {
	const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
	if (!locks) {
		if (resuming)
			throw new Error(
				"This browser cannot safely resume an import across tabs",
			);
		return run();
	}
	return locks.request(
		`opencut-import:${accountId}:${projectId}:${uploadToken}`,
		{ ifAvailable: true },
		(lock) => {
			if (!lock) throw new Error("This import is still running in another tab");
			return run();
		},
	);
}
