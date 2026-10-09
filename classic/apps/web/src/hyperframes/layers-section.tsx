"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
	Loader2,
	Layers,
	Image,
	Film,
	Music2,
	Box,
	Eye,
	EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	HyperframesSourceEditor,
	type HyperframesSourceDraft,
} from "./source-section";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import {
	useEditor,
	useEditorProject,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import type {
	HyperframesComposition,
	HyperframesRuntimeLayer,
	HyperframesTimelineClip,
} from "./types";

const LAYER_ICONS = {
	composition: Layers,
	element: Box,
	image: Image,
	video: Film,
	audio: Music2,
};
const seconds = (value: number) => `${Number(value.toFixed(3))}s`;

/** Inspector view of the canonical runtime manifest. Local state is UI only. */
export function HyperframesLayersSection({
	assetId,
	elementId,
}: {
	assetId: string;
	elementId: string;
}) {
	const { projectId, composition } = useEditorProject((core) => {
		const project = core.project.getActiveOrNull();
		return {
			projectId: project?.metadata.id,
			composition: project?.hyperframesCompositions?.[assetId],
		};
	});
	return (
		<HyperframesLayersInspector
			key={`${projectId}:${elementId}`}
			projectId={projectId}
			assetId={assetId}
			elementId={elementId}
			composition={composition}
		/>
	);
}

function HyperframesLayersInspector({
	projectId,
	assetId,
	elementId,
	composition,
}: {
	projectId?: string;
	assetId: string;
	elementId: string;
	composition?: HyperframesComposition;
}) {
	const editor = useEditor();
	const operation = useRef<AbortController | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [sourceDraft, setSourceDraft] = useState<HyperframesSourceDraft | null>(
		null,
	);
	const [limit, setLimit] = useState(100);
	useEffect(
		() => () => {
			operation.current?.abort();
			operation.current = null;
		},
		[projectId, assetId, elementId],
	);
	const manifest = composition?.runtimeManifest;
	const scene = useEditorTimelineScenes((core) =>
		core.scenes.getActiveSceneOrNull(),
	);
	const [controls, setControls] = useState<{
		scene: typeof scene;
		manifest: typeof manifest;
		values: HyperframesTimelineClip["controls"];
	} | null>(null);
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		let active = true;
		if (!scene || !projectId || !manifest) return;
		const accountId = window.__opencutAccountId;
		void editor.command
			.readHyperframesLayerRows({ projectId, sceneId: scene.id, elementId })
			.then(
				({ clip }) => {
					if (active && window.__opencutAccountId === accountId)
						setControls({ scene, manifest, values: clip.controls });
				},
				(cause: unknown) => {
					if (active)
						setError(cause instanceof Error ? cause.message : String(cause));
				},
			);
		return () => {
			active = false;
		};
	}, [editor, projectId, elementId, scene, manifest]);
	const controlMap = new Map(
		(controls?.scene === scene && controls.manifest === manifest
			? controls.values
			: []
		).map((control) => [control.key, control]),
	);
	const setOpacity = async ({
		layerKey,
		opacity,
	}: {
		layerKey: string;
		opacity: number;
	}) => {
		if (!projectId || !scene || operation.current) return;
		const controller = new AbortController();
		operation.current = controller;
		setSaving(true);
		setError(null);
		try {
			await editor.command.setHyperframesLayerOpacity({
				projectId,
				sceneId: scene.id,
				elementId,
				layerKey,
				opacity,
				signal: controller.signal,
			});
		} catch (cause) {
			if (!controller.signal.aborted)
				setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (operation.current === controller) operation.current = null;
			if (!operation.current) setSaving(false);
		}
	};
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
	const moveLayer = async ({
		layerKey,
		startSeconds,
	}: {
		layerKey: string;
		startSeconds: number;
	}) => {
		if (!projectId || !scene || !composition || !manifest || operation.current)
			return;
		const controller = new AbortController();
		operation.current = controller;
		setSaving(true);
		setError(null);
		try {
			await editor.command.moveHyperframesLayer({
				projectId,
				sceneId: scene.id,
				elementId,
				source: composition.source,
				manifest,
				layerKey,
				startSeconds,
				signal: controller.signal,
			});
		} catch (cause) {
			if (!controller.signal.aborted)
				setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (operation.current === controller) operation.current = null;
			// Detaching a shared source changes assetId and releases the old
			// controller. Clear its feedback unless a new edit has started.
			if (!operation.current) setSaving(false);
		}
	};
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
						disabled={busy || saving || !composition}
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
				{saving && (
					<p role="status" className="text-muted-foreground text-xs">
						Checking layer changes…{" "}
						<button
							type="button"
							className="underline"
							onClick={() => operation.current?.abort()}
						>
							Cancel
						</button>
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
								<LayerRow
									key={layer.key}
									layer={layer}
									onMove={(start) =>
										void moveLayer({ layerKey: layer.key, startSeconds: start })
									}
									onSource={() => {
										if (projectId && scene && composition)
											setSourceDraft({
												projectId,
												sceneId: scene.id,
												elementId,
												accountId: window.__opencutAccountId,
												source: composition.source,
												layerTarget: { manifest, layerKey: layer.key },
											});
									}}
									depth={depth}
									control={controlMap.get(layer.key)}
									disabled={busy || saving}
									onOpacity={(opacity) =>
										void setOpacity({ layerKey: layer.key, opacity })
									}
								/>
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
								Layer opacity changes visuals only.
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
				{sourceDraft &&
					sourceDraft.projectId === projectId &&
					sourceDraft.sceneId === scene?.id &&
					sourceDraft.elementId === elementId && (
						<HyperframesSourceEditor
							key={`${projectId}:${scene.id}:${elementId}:${sourceDraft.layerTarget?.layerKey}`}
							{...sourceDraft}
							onClose={() => setSourceDraft(null)}
						/>
					)}
			</SectionContent>
		</Section>
	);
}

function LayerRow({
	layer,
	depth,
	control,
	disabled,
	onOpacity,
	onSource,
	onMove,
}: {
	layer: HyperframesRuntimeLayer;
	depth: number;
	control?: HyperframesTimelineClip["controls"][number];
	disabled: boolean;
	onOpacity: (opacity: number) => void;
	onSource: () => void;
	onMove: (startSeconds: number) => void;
}) {
	const Icon = LAYER_ICONS[layer.kind];
	const opacity = control?.opacity ?? 1;
	const percentage = Number((opacity * 100).toFixed(4));
	const VisibilityIcon = opacity === 0 ? EyeOff : Eye;
	const label = layer.label || layer.elementId || layer.kind;
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
				{control?.editable && (
					<Button
						variant="ghost"
						size="icon"
						disabled={disabled}
						aria-label={`${opacity === 0 ? "Show" : "Hide"} layer ${label}`}
						title={`${opacity === 0 ? "Show" : "Hide"} layer`}
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							onOpacity(opacity === 0 ? 1 : 0);
						}}
					>
						<VisibilityIcon />
					</Button>
				)}
			</summary>
			<label className="flex items-center gap-2 px-3 pb-3 text-xs">
				Start in source (s)
				<input
					key={layer.startSeconds}
					type="number"
					min={0}
					step={0.001}
					defaultValue={layer.startSeconds}
					disabled={disabled}
					aria-label={`Layer start: ${label}`}
					className="border-input bg-background h-7 w-24 rounded border px-2 tabular-nums"
					onBlur={(event) => {
						const value = event.currentTarget.valueAsNumber;
						if (
							Number.isFinite(value) &&
							value >= 0 &&
							value !== layer.startSeconds
						)
							onMove(value);
						event.currentTarget.value = String(layer.startSeconds);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
					}}
				/>
			</label>
			{control?.editable && (
				<div className="flex items-center gap-2 px-3 pb-3 text-xs">
					<label className="flex items-center gap-2">
						Opacity
						<input
							key={opacity}
							type="number"
							min={0}
							max={100}
							step={1}
							defaultValue={percentage}
							disabled={disabled}
							aria-label={`Layer opacity: ${label}`}
							className="border-input bg-background h-7 w-16 rounded border px-2 tabular-nums"
							onBlur={(event) => {
								const value = event.currentTarget.valueAsNumber;
								if (
									event.currentTarget.value !== "" &&
									Number.isFinite(value) &&
									value >= 0 &&
									value <= 100
								) {
									if (value !== percentage) onOpacity(value / 100);
								} else event.currentTarget.value = String(percentage);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
						/>
						<span>%</span>
					</label>
					<Button
						variant="ghost"
						size="sm"
						disabled={disabled || opacity === 1}
						onClick={() => onOpacity(1)}
					>
						Reset
					</Button>
				</div>
			)}
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
			<div className="px-3 pb-3">
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={onSource}
					aria-label={`Edit source for layer ${label}`}
				>
					Edit layer source
				</Button>
			</div>
		</details>
	);
}
