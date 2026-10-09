/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The canonical registry validates these JSON contracts. */
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import type { MediaAsset } from "@/media/types";
import type {
	HyperframesInspection,
	HyperframesPackagePlan,
	HyperframesSource,
} from "./types";
import { generateUUID } from "@/utils/id";

export interface HyperframesFolder {
	name: string;
	files: ReadonlyMap<string, File>;
	plan: HyperframesPackagePlan;
}

export interface PreparedHyperframesFolder {
	name: string;
	source: HyperframesSource;
	resources: MediaAsset[];
	inspection: HyperframesInspection;
}

/** Convert the browser's directory selection to package-relative paths. */
export function planHyperframesFolder({
	files,
	runtime,
	entryFile,
}: {
	files: readonly File[];
	runtime: CanonicalEditorRuntime;
	entryFile?: string;
}): HyperframesFolder {
	const name = files[0]?.webkitRelativePath.split("/")[0];
	if (!name)
		throw new Error("Choose the folder containing your HyperFrames project");
	const selected = new Map<string, File>();
	const entries = files.map((file) => {
		if (!file.webkitRelativePath.startsWith(`${name}/`))
			throw new Error("Select one HyperFrames project folder at a time");
		const path = file.webkitRelativePath.slice(name.length + 1);
		selected.set(path, file);
		return { path, size: file.size };
	});
	const receipt = runtime.invokeSync(
		"hyperframes.package.plan",
		{
			files: entries,
			...(entryFile && { entryFile }),
		},
		undefined,
	) as { result: { data: HyperframesPackagePlan } };
	return { name, files: selected, plan: receipt.result.data };
}

/** Reading File bytes is the host's job; package rules and inspection stay in Rust. */
export async function readHyperframesFolder({
	folder,
	runtime,
	signal,
}: {
	folder: HyperframesFolder;
	runtime: CanonicalEditorRuntime;
	signal?: AbortSignal;
}): Promise<PreparedHyperframesFolder> {
	signal?.throwIfAborted();
	const entryFile = folder.plan.entryFile;
	if (!entryFile)
		throw new Error("Choose the HTML entry file before importing");
	const source: HyperframesSource = {
		entryFile,
		files: Object.create(null) as Record<string, string>,
		resourceAssetIds: Object.create(null) as Record<string, string>,
	};
	const resources: MediaAsset[] = [];
	// Sequential bounded reads avoid loading all source and binary resources in memory together.
	for (const planned of folder.plan.files) {
		signal?.throwIfAborted();
		const file = folder.files.get(planned.path);
		if (!file || file.size !== planned.size)
			throw new Error(`The selected file changed: ${planned.path}`);
		if (planned.kind === "source") {
			try {
				// ignoreBOM=true preserves an authored BOM in the stored string.
				source.files[planned.path] = new TextDecoder("utf-8", {
					fatal: true,
					ignoreBOM: true,
				}).decode(await file.arrayBuffer());
			} catch (error) {
				throw new Error(`Cannot read ${planned.path} as UTF-8 source`, {
					cause: error,
				});
			}
		} else {
			const id = generateUUID();
			source.resourceAssetIds[planned.path] = id;
			resources.push({
				id,
				name: planned.path,
				type: planned.mediaType,
				file: new File([file], file.name, {
					type: planned.mimeType,
					lastModified: file.lastModified,
				}),
				size: file.size,
				lastModified: file.lastModified,
				fileName: file.name,
				mimeType: planned.mimeType,
				storageKind: "copied",
			});
		}
	}
	signal?.throwIfAborted();
	const receipt = runtime.invokeSync(
		"hyperframes.project.inspect",
		{ source },
		undefined,
	) as { result: { data: HyperframesInspection } };
	return {
		name: folder.name,
		source,
		resources,
		inspection: receipt.result.data,
	};
}
