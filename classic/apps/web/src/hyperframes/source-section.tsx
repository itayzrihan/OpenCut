"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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
import { loadCanonicalRuntime } from "@/core/load-canonical-runtime";
import type {
	HyperframesLayerSource,
	HyperframesRuntimeManifest,
	HyperframesSource,
} from "./types";

export interface HyperframesSourceDraft {
	projectId: string;
	sceneId: string;
	elementId: string;
	accountId: string | null;
	source: HyperframesSource;
	layerTarget?: { manifest: HyperframesRuntimeManifest; layerKey: string };
}

export function HyperframesSourceSection({
	assetId,
	elementId,
}: {
	assetId: string;
	elementId: string;
}) {
	const state = useEditorProject((core) => {
		const project = core.project.getActiveOrNull();
		return {
			projectId: project?.metadata.id,
			source: project?.hyperframesCompositions?.[assetId]?.source,
		};
	});
	const sceneId = useEditorTimelineScenes(
		(core) => core.scenes.getActiveSceneOrNull()?.id,
	);
	const [draft, setDraft] = useState<HyperframesSourceDraft | null>(null);
	if (!state.projectId || !state.source || !sceneId) return null;
	return (
		<Section collapsible sectionKey="hyperframes-source">
			<SectionHeader>
				<SectionTitle>Source files</SectionTitle>
			</SectionHeader>
			<SectionContent className="flex flex-col gap-3">
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						if (state.projectId && state.source)
							setDraft({
								projectId: state.projectId,
								sceneId,
								elementId,
								accountId: window.__opencutAccountId,
								source: state.source,
							});
					}}
				>
					Edit source
				</Button>
				{draft &&
					draft.projectId === state.projectId &&
					draft.sceneId === sceneId &&
					draft.elementId === elementId && (
						<HyperframesSourceEditor
							key={`${state.projectId}:${sceneId}:${elementId}`}
							{...draft}
							onClose={() => setDraft(null)}
						/>
					)}
			</SectionContent>
		</Section>
	);
}

export function HyperframesSourceEditor({
	projectId,
	sceneId,
	elementId,
	accountId,
	source,
	layerTarget,
	onClose,
}: HyperframesSourceDraft & {
	onClose: () => void;
}) {
	const editor = useEditor();
	const id = useId();
	const [file, setFile] = useState(source.entryFile);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [locating, setLocating] = useState(!!layerTarget);
	const [target, setTarget] = useState<HyperframesLayerSource | null>(null);
	const code = useRef<HTMLTextAreaElement | null>(null);
	const highlighted = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const operation = useRef<AbortController | null>(null);
	useEffect(() => () => operation.current?.abort(), []);
	useEffect(() => {
		if (!layerTarget) return;
		let active = true;
		void loadCanonicalRuntime()
			.then((runtime) => {
				try {
					if (!active || window.__opencutAccountId !== accountId) return;
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The Rust capability validates both input and output schemas.
					const result = runtime.invokeSync(
						"hyperframes.layer.source.read",
						{
							source,
							...layerTarget,
						},
						undefined,
					) as { result: { data: HyperframesLayerSource } };
					setTarget(result.result.data);
					if (result.result.data.file) setFile(result.result.data.file);
				} finally {
					runtime.free();
				}
			})
			.catch((cause: unknown) => {
				if (active)
					setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (active) setLocating(false);
			});
		return () => {
			active = false;
		};
	}, [source, layerTarget, accountId]);
	useEffect(() => {
		if (
			locating ||
			highlighted.current ||
			!code.current ||
			!target?.location ||
			target.file !== file
		)
			return;
		highlighted.current = true;
		code.current.focus();
		code.current.setSelectionRange(
			target.location.startTextarea,
			target.location.endTextarea,
		);
		const lineHeight =
			Number.parseFloat(getComputedStyle(code.current).lineHeight) || 20;
		code.current.scrollTop = Math.max(
			0,
			(target.location.line - 3) * lineHeight,
		);
	}, [locating, target, file]);
	const changes = Object.fromEntries(
		Object.entries(drafts).filter(
			([path, text]) => source.files[path] !== text,
		),
	);
	const changedCount = Object.keys(changes).length;
	const close = () => {
		operation.current?.abort();
		onClose();
	};
	const apply = async () => {
		if (!changedCount || operation.current) return;
		const controller = new AbortController();
		operation.current = controller;
		setBusy(true);
		setError(null);
		try {
			if (window.__opencutAccountId !== accountId)
				throw new Error("The account changed. Reopen the source editor.");
			await editor.command.setHyperframesSource({
				projectId,
				sceneId,
				elementId,
				source,
				changes,
				signal: controller.signal,
			});
			onClose();
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
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
				<DialogHeader>
					<DialogTitle>
						{layerTarget ? "Edit layer source" : "Edit composition source"}
					</DialogTitle>
					<DialogDescription>
						Change this clip’s HTML, styles or animation code. Changes are
						checked before applying and can be undone.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="min-h-0 overflow-auto">
					{layerTarget && (
						<div className="text-sm text-muted-foreground" role="status">
							{locating
								? "Finding the layer’s source…"
								: target?.location
									? `${target.file}: opening tag at line ${target.location.line}, column ${target.location.column}.`
									: "No unique opening tag was found for this layer. You can still edit the source files."}
							{!locating && (
								<p>
									File edits affect every use of that file within this clip.
									{target && target.reportedOccurrences > 1
										? ` This tag appears in ${target.reportedOccurrences} reported layers.`
										: ""}
								</p>
							)}
						</div>
					)}
					<label htmlFor={`${id}-file`} className="text-sm font-medium">
						Source file
					</label>
					<select
						id={`${id}-file`}
						className="h-9 rounded-md border bg-background px-3 text-sm"
						value={file}
						disabled={busy || locating}
						onChange={(event) => setFile(event.target.value)}
					>
						{Object.keys(source.files)
							.sort()
							.map((path) => (
								<option key={path} value={path}>
									{path}
									{Object.hasOwn(changes, path) ? " · edited" : ""}
								</option>
							))}
					</select>
					<Textarea
						ref={code}
						aria-label={`Source code: ${file}`}
						value={drafts[file] ?? source.files[file]}
						onChange={(event) =>
							setDrafts((current) => ({
								...current,
								[file]: event.target.value,
							}))
						}
						disabled={busy || locating}
						spellCheck={false}
						wrap="off"
						className="h-[45vh] min-h-40 font-mono text-xs md:text-xs leading-5"
					/>
					{busy && (
						<p role="status" className="text-sm">
							Checking the updated animation…
						</p>
					)}
					{error && (
						<p
							role="alert"
							className="max-h-28 overflow-auto break-words text-sm text-destructive"
						>
							{error}
						</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={close}>
						{busy ? "Cancel check" : "Cancel"}
					</Button>
					<Button
						disabled={busy || locating || !changedCount}
						onClick={() => void apply()}
					>
						Apply changes{changedCount ? ` (${changedCount})` : ""}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
