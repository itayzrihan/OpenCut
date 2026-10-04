import type { MediaAsset } from "@/media/types";
import type { TProject } from "@/project/types";
import { HyperframesRenderClient } from "./render-client";
import type {
	HyperframesRenderContext,
	HyperframesRuntimeManifest,
} from "./types";

type RenderProject = Pick<TProject, "metadata" | "hyperframesCompositions">;

/** Derived browser resources only. Project data stays in the canonical runtime. */
export class HyperframesRenderCache {
	private client: HyperframesRenderClient | null = null;
	private projectId: string | null = null;
	private accountId: string | null = null;
	private scopeRevision = 0;
	private resourceRevision = 0;
	private bindings = new Map<string, ReturnType<typeof resourceBinding>>();

	get revision(): number {
		return this.resourceRevision;
	}

	/** Returns true only when existing rendered frames have become invalid. */
	update({
		project,
		mediaAssets,
	}: {
		project: RenderProject | null;
		mediaAssets: readonly MediaAsset[];
	}): boolean {
		const projectId = project?.metadata.id ?? null;
		const accountId = currentAccountId();
		let changed = this.projectId !== projectId || this.accountId !== accountId;
		if (changed) {
			this.bindings.clear();
			this.scopeRevision++;
			this.projectId = projectId;
			this.accountId = accountId;
		}

		const usedIds = new Set(
			Object.values(project?.hyperframesCompositions ?? {}).flatMap(
				({ source }) => Object.values(source.resourceAssetIds),
			),
		);
		// Keep dependencies of cached sources after a clip/source is deleted.
		// Undo can restore that source while its old browser is still cached.
		const observedIds = new Set([...this.bindings.keys(), ...usedIds]);
		const assets = new Map(mediaAssets.map((asset) => [asset.id, asset]));
		const next = new Map<string, ReturnType<typeof resourceBinding>>();
		for (const id of observedIds) {
			const binding = resourceBinding(assets.get(id));
			next.set(id, binding);
			if (
				this.bindings.has(id) &&
				!sameBinding(this.bindings.get(id), binding)
			) {
				changed = true;
			}
		}
		if (changed) {
			this.reset();
			// No old browser remains after reset, so unused dependencies can go.
			for (const id of next.keys()) if (!usedIds.has(id)) next.delete(id);
		}
		this.bindings = next;
		return changed;
	}

	getContext(
		project: RenderProject | null,
	): HyperframesRenderContext | undefined {
		if (
			!project?.hyperframesCompositions ||
			Object.keys(project.hyperframesCompositions).length === 0
		)
			return undefined;
		const projectId = project.metadata.id;
		const scopeRevision = this.scopeRevision;
		return {
			compositions: project.hyperframesCompositions,
			getResourceRevision: () => this.resourceRevision,
			renderTo: async (input) => {
				if (
					this.projectId !== projectId ||
					this.scopeRevision !== scopeRevision ||
					this.accountId !== currentAccountId()
				)
					throw new Error(
						"The HyperFrames render belongs to a previous project or account",
					);
				this.client ??= new HyperframesRenderClient(projectId);
				await this.client.renderTo(input);
			},
		};
	}

	async readManifest({
		project,
		assetId,
		signal,
	}: {
		project: RenderProject;
		assetId: string;
		signal?: AbortSignal;
	}): Promise<HyperframesRuntimeManifest> {
		const projectId = project.metadata.id;
		const composition = project.hyperframesCompositions?.[assetId];
		const scopeRevision = this.scopeRevision;
		const revision = this.resourceRevision;
		const checkScope = () => {
			signal?.throwIfAborted();
			if (
				this.projectId !== projectId ||
				this.scopeRevision !== scopeRevision ||
				this.accountId !== currentAccountId() ||
				this.resourceRevision !== revision
			)
				throw new Error(
					"The HyperFrames project, account or media changed while reading layers",
				);
		};
		checkScope();
		if (!composition) throw new Error("HyperFrames composition is missing");
		this.client ??= new HyperframesRenderClient(projectId);
		const ready = await this.client.prepareSource(composition.source);
		checkScope();
		return structuredClone(ready.runtimeManifest);
	}

	reset(): void {
		this.client?.dispose();
		this.client = null;
		this.resourceRevision++;
	}

	dispose(): void {
		this.reset();
		this.bindings.clear();
		this.projectId = null;
		this.scopeRevision++;
	}
}

function currentAccountId(): string | null {
	return typeof window === "undefined" ? null : window.__opencutAccountId;
}

function resourceBinding(asset: MediaAsset | undefined) {
	if (!asset) return undefined;
	// Copy values: relink/loading code can update a MediaAsset in place.
	// Names, thumbnails and presentation metadata do not change package bytes.
	return [
		asset.file,
		asset.url,
		asset.size,
		asset.lastModified,
		asset.fileName,
		asset.mimeType,
		asset.storageKind,
		asset.sourcePath,
		asset.missing ?? false,
		asset.bindingRevision ?? 0,
	] as const;
}

// eslint-disable-next-line opencut/prefer-object-params -- Pairwise tuple equality.
function sameBinding(
	previous: ReturnType<typeof resourceBinding>,
	next: ReturnType<typeof resourceBinding>,
): boolean {
	return (
		previous === next ||
		!!(next && previous?.every((value, i) => value === next[i]))
	);
}
