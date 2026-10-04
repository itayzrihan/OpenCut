"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Layers, Image, Film, Music2, Box } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor, useEditorProject } from "@/editor/use-editor";
import type { HyperframesComposition, HyperframesRuntimeLayer } from "./types";

const LAYER_ICONS = {
	composition: Layers,
	element: Box,
	image: Image,
	video: Film,
	audio: Music2,
};
const seconds = (value: number) => `${Number(value.toFixed(3))}s`;

/** Inspector view of the canonical runtime manifest. Local state is UI only. */
export function HyperframesLayersSection({ assetId }: { assetId: string }) {
	const { projectId, composition } = useEditorProject((core) => {
		const project = core.project.getActiveOrNull();
		return {
			projectId: project?.metadata.id,
			composition: project?.hyperframesCompositions?.[assetId],
		};
	});
	return (
		<HyperframesLayersInspector
			key={`${projectId}:${assetId}`}
			projectId={projectId}
			assetId={assetId}
			composition={composition}
		/>
	);
}

function HyperframesLayersInspector({
	projectId,
	assetId,
	composition,
}: {
	projectId?: string;
	assetId: string;
	composition?: HyperframesComposition;
}) {
	const editor = useEditor();
	const operation = useRef<AbortController | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [limit, setLimit] = useState(100);
	useEffect(
		() => () => {
			operation.current?.abort();
			operation.current = null;
		},
		[projectId, assetId],
	);
	const manifest = composition?.runtimeManifest;
	const rows = useMemo(() => {
		const children = new Map<string | null, HyperframesRuntimeLayer[]>();
		for (const layer of manifest?.layers ?? []) {
			const siblings = children.get(layer.parentKey) ?? [];
			siblings.push(layer);
			children.set(layer.parentKey, siblings);
		}
		const result: Array<{ layer: HyperframesRuntimeLayer; depth: number }> = [];
		const visit = ({
			parent,
			depth,
		}: {
			parent: string | null;
			depth: number;
		}) => {
			for (const layer of children.get(parent) ?? []) {
				result.push({ layer, depth });
				visit({ parent: layer.key, depth: depth + 1 });
			}
		};
		visit({ parent: null, depth: 0 });
		return result;
	}, [manifest]);
	const matches = rows.filter(({ layer }) =>
		[
			layer.label,
			layer.elementId,
			layer.kind,
			layer.resourcePath,
			layer.file,
		].some((value) =>
			value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
		),
	);

	const analyze = async () => {
		if (!projectId || !composition || operation.current) return;
		const controller = new AbortController();
		operation.current = controller;
		const accountId = window.__opencutAccountId;
		setBusy(true);
		setError(null);
		try {
			const manifest = await editor.renderer.readHyperframesManifest({
				assetId,
				signal: controller.signal,
			});
			controller.signal.throwIfAborted();
			if (window.__opencutAccountId !== accountId)
				throw new Error("The active account changed while loading layers.");
			await editor.command.setHyperframesManifest({
				projectId,
				assetId,
				manifest,
				signal: controller.signal,
			});
		} catch (cause) {
			if (!controller.signal.aborted)
				setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (operation.current === controller) {
				operation.current = null;
				setBusy(false);
			}
		}
	};

	return (
		<Section collapsible sectionKey={`${assetId}:hyperframes-layers`}>
			<SectionHeader>
				<SectionTitle>Composition layers</SectionTitle>
			</SectionHeader>
			<SectionContent className="flex flex-col gap-3">
				<p className="text-muted-foreground text-xs">
					{manifest
						? `${manifest.layers.length} ${manifest.layers.length === 1 ? "layer" : "layers"} · ${seconds(manifest.durationSeconds)} · times within the source composition`
						: "See the layers and timing inside this composition."}
				</p>
				<div className="flex items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={busy || !composition}
						onClick={() => void analyze()}
					>
						{busy && <Loader2 className="animate-spin" />}
						{busy
							? "Reading layers…"
							: manifest
								? "Refresh layers"
								: "Read layers"}
					</Button>
					{busy && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => operation.current?.abort()}
						>
							Cancel
						</Button>
					)}
				</div>
				{error && (
					<p role="alert" className="text-destructive text-xs break-words">
						{error}
					</p>
				)}
				{manifest && (
					<>
						<input
							aria-label="Find composition layers"
							placeholder="Find a layer or file…"
							value={query}
							onChange={(event) => {
								setQuery(event.target.value);
								setLimit(100);
							}}
							className="border-input bg-background h-8 w-full rounded-md border px-2 text-xs"
						/>
						<div
							className="max-h-96 overflow-y-auto rounded-md border"
							aria-label="Composition layer list"
						>
							{matches.slice(0, limit).map(({ layer, depth }) => (
								<LayerRow key={layer.key} layer={layer} depth={depth} />
							))}
							{!matches.length && (
								<p className="text-muted-foreground p-3 text-xs">
									{query.trim()
										? "No matching layers."
										: "No timed layers reported by this composition."}
								</p>
							)}
						</div>
						{matches.length > limit && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setLimit((value) => value + 100)}
							>
								Show more ({matches.length - limit} remaining)
							</Button>
						)}
						{manifest.layers.some((layer) => layer.kind === "audio") && (
							<p className="text-muted-foreground text-xs">
								Embedded audio follows this clip during playback and export.
							</p>
						)}
						{manifest.diagnostics.length > 0 && (
							<details className="text-muted-foreground text-xs">
								<summary className="cursor-pointer">
									Layer details need attention ({manifest.diagnostics.length})
								</summary>
								<ul className="mt-2 list-disc space-y-1 pl-4">
									{manifest.diagnostics.map((message, index) => (
										<li key={index}>{message}</li>
									))}
								</ul>
							</details>
						)}
					</>
				)}
			</SectionContent>
		</Section>
	);
}

function LayerRow({
	layer,
	depth,
}: {
	layer: HyperframesRuntimeLayer;
	depth: number;
}) {
	const Icon = LAYER_ICONS[layer.kind];
	return (
		<details className="border-b last:border-b-0">
			<summary
				className="flex cursor-pointer items-center gap-2 py-2 pr-2 text-xs hover:bg-accent"
				style={{ paddingLeft: 8 + Math.min(depth, 5) * 10 }}
			>
				<Icon
					className="text-muted-foreground size-3.5 shrink-0"
					aria-label={layer.kind}
				/>
				<span className="min-w-0 flex-1 truncate" title={layer.label}>
					{layer.label || layer.elementId || layer.kind}
				</span>
				<span className="text-muted-foreground shrink-0 tabular-nums">
					{seconds(layer.startSeconds)} · {seconds(layer.durationSeconds)}
				</span>
			</summary>
			<dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all px-3 pb-3 text-xs">
				<dt>Type</dt>
				<dd className="capitalize">{layer.kind}</dd>
				<dt>Source file</dt>
				<dd>{layer.file ?? "Unresolved"}</dd>
				{layer.elementId && (
					<>
						<dt>Element</dt>
						<dd>{layer.elementId}</dd>
					</>
				)}
				{layer.resourcePath && (
					<>
						<dt>Media</dt>
						<dd>{layer.resourcePath}</dd>
					</>
				)}
				<dt>Track</dt>
				<dd>{layer.trackIndex}</dd>
				<dt>Time range</dt>
				<dd>
					{seconds(layer.startSeconds)}–
					{seconds(layer.startSeconds + layer.durationSeconds)}
				</dd>
				{layer.media && (
					<>
						<dt>Media offset</dt>
						<dd>{seconds(layer.playbackStartSeconds)}</dd>
						<dt>Speed</dt>
						<dd>{layer.playbackRate}×</dd>
						<dt>Authored mute</dt>
						<dd>{layer.media.muted ? "Muted" : "Unmuted"}</dd>
					</>
				)}
			</dl>
		</details>
	);
}
