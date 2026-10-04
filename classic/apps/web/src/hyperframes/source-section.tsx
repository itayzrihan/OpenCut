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
import type { HyperframesSource } from "./types";

interface SourceDraft {
	projectId: string;
	sceneId: string;
	elementId: string;
	accountId: string | null;
	source: HyperframesSource;
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
	const [draft, setDraft] = useState<SourceDraft | null>(null);
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
						<SourceEditor
							key={`${state.projectId}:${sceneId}:${elementId}`}
							{...draft}
							onClose={() => setDraft(null)}
						/>
					)}
			</SectionContent>
		</Section>
	);
}

function SourceEditor({
	projectId,
	sceneId,
	elementId,
	accountId,
	source,
	onClose,
}: SourceDraft & {
	onClose: () => void;
}) {
	const editor = useEditor();
	const id = useId();
	const [file, setFile] = useState(source.entryFile);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const operation = useRef<AbortController | null>(null);
	useEffect(() => () => operation.current?.abort(), []);
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
					<DialogTitle>Edit composition source</DialogTitle>
					<DialogDescription>
						Change this clip’s HTML, styles or animation code. Changes are
						checked before applying and can be undone.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="min-h-0 overflow-auto">
					<label htmlFor={`${id}-file`} className="text-sm font-medium">
						Source file
					</label>
					<select
						id={`${id}-file`}
						className="h-9 rounded-md border bg-background px-3 text-sm"
						value={file}
						disabled={busy}
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
						aria-label={`Source code: ${file}`}
						value={drafts[file] ?? source.files[file]}
						onChange={(event) =>
							setDrafts((current) => ({
								...current,
								[file]: event.target.value,
							}))
						}
						disabled={busy}
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
					<Button disabled={busy || !changedCount} onClick={() => void apply()}>
						Apply changes{changedCount ? ` (${changedCount})` : ""}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
