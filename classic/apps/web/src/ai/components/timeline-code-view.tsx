"use client";

import { useMemo, useState } from "react";
import { Braces, Check, Copy, RotateCcw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
	buildTimelineDocumentV2,
	parseTimelineDocumentV2,
	type TimelineDocumentV2Diagnostic,
} from "@/ai/timeline-document-v2";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
	useEditor,
	useEditorProject,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import { updateSceneInArray } from "@/timeline/scenes";

interface SourceSession {
	sceneId: string;
	baseRevision: string;
	baseText: string;
	draft: string;
}

function formatDiagnostic(diagnostic: TimelineDocumentV2Diagnostic): string {
	return `${diagnostic.path}: ${diagnostic.message}`;
}

export function TimelineCodeView() {
	const editor = useEditor();
	const activeScene = useEditorTimelineScenes((value) =>
		value.scenes.getActiveSceneOrNull(),
	);
	const activeProject = useEditorProject((value) =>
		value.project.getActiveOrNull(),
	);
	const liveDocument = useMemo(
		() =>
			activeScene && activeProject
				? buildTimelineDocumentV2({
						project: activeProject,
						scene: activeScene,
					})
				: null,
		[activeProject, activeScene],
	);
	const [storedSession, setStoredSession] = useState<SourceSession | null>(
		null,
	);
	const [issues, setIssues] = useState<string[]>([]);
	const [notes, setNotes] = useState<string[]>([]);

	const session =
		storedSession?.sceneId === activeScene?.id ? storedSession : null;
	const sourceText = session?.draft ?? liveDocument?.formattedText ?? "";
	const isDirty = Boolean(session && session.draft !== session.baseText);
	const isStale = Boolean(
		session &&
		liveDocument?.baseRevision &&
		session.baseRevision !== liveDocument.baseRevision,
	);
	const lineCount = sourceText ? sourceText.split("\n").length : 0;
	const sourceUnavailable = Boolean(liveDocument && !liveDocument.valid);

	const reset = () => {
		setStoredSession(null);
		setIssues([]);
		setNotes([]);
	};

	const copy = async () => {
		if (!sourceText) return;
		await navigator.clipboard.writeText(sourceText);
		toast.success("Timeline source copied");
	};

	const setDraft = (draft: string) => {
		if (!activeScene || !liveDocument?.valid) return;
		setStoredSession((current) => {
			if (current?.sceneId === activeScene.id) {
				return { ...current, draft };
			}
			return {
				sceneId: activeScene.id,
				baseRevision: liveDocument.baseRevision,
				baseText: liveDocument.formattedText,
				draft,
			};
		});
		setIssues([]);
		setNotes([]);
	};

	const format = () => {
		if (!sourceText) return;
		const parsed = parseTimelineDocumentV2({ text: sourceText });
		if (!parsed.valid || !parsed.value) {
			setIssues(parsed.diagnostics.map(formatDiagnostic));
			return;
		}
		setDraft(parsed.formattedText);
		setIssues([]);
		setNotes(["Canonical JSON formatting applied."]);
	};

	const apply = () => {
		if (!activeProject || !activeScene || !liveDocument || !session) return;
		const currentScene = editor.scenes.getActiveSceneOrNull();
		if (!currentScene || currentScene.id !== session.sceneId) {
			setIssues([
				"The active scene changed. Reset before applying this source.",
			]);
			return;
		}

		const currentDocument = buildTimelineDocumentV2({
			project: editor.project.getActive(),
			scene: currentScene,
		});
		if (
			!currentDocument.valid ||
			currentDocument.baseRevision !== session.baseRevision
		) {
			setIssues([
				"The timeline changed after you started editing. Reset to load the latest version, then reapply your changes.",
			]);
			return;
		}

		const parsed = parseTimelineDocumentV2({ text: session.draft });
		if (!parsed.valid || !parsed.value) {
			setIssues(parsed.diagnostics.map(formatDiagnostic));
			return;
		}
		if (parsed.value.scene.id !== currentScene.id) {
			setIssues([
				"$.scene.id: the active scene id is immutable in Timeline Source.",
			]);
			return;
		}
		if (parsed.value.scene.isMain !== currentScene.isMain) {
			setIssues([
				"$.scene.isMain: scene role is immutable in Timeline Source.",
			]);
			return;
		}
		if (parsed.formattedText === currentDocument.formattedText) {
			setStoredSession(null);
			setIssues([]);
			setNotes([]);
			toast.info("No timeline changes to apply");
			return;
		}

		try {
			editor.command.executeTransaction({
				execute: () => {
					const value = parsed.value;
					if (!value) return;
					const scenes = updateSceneInArray({
						scenes: editor.scenes.getScenes(),
						sceneId: currentScene.id,
						updates: {
							name: value.scene.name,
							createdAt: value.scene.createdAt,
							updatedAt: value.scene.updatedAt,
							tracks: value.tracks,
							bookmarks: value.bookmarks,
						},
					});
					editor.scenes.setScenes({
						scenes,
						activeSceneId: currentScene.id,
					});
					const project = editor.project.getActive();
					editor.project.setActiveProject({
						project: {
							...project,
							settings: value.projectSettings,
							metadata: {
								...project.metadata,
								updatedAt: new Date(),
							},
						},
					});
					editor.save.markDirty();
				},
			});
			setStoredSession(null);
			setIssues([]);
			setNotes(["Applied as one undoable Timeline Source transaction."]);
			toast.success("Timeline source applied");
		} catch (error) {
			setIssues([
				error instanceof Error
					? error.message
					: "Failed to apply timeline source",
			]);
		}
	};

	if (!activeScene || !activeProject || !liveDocument) {
		return (
			<div className="text-muted-foreground flex size-full items-center justify-center p-4 text-sm">
				Open a scene to inspect its timeline code.
			</div>
		);
	}

	const displayedIssues =
		issues.length > 0
			? issues
			: sourceUnavailable
				? liveDocument.diagnostics.map(formatDiagnostic)
				: [];

	return (
		<div className="flex size-full min-h-0 flex-col overflow-hidden">
			<div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
				<div className="min-w-0">
					<div className="truncate text-sm font-medium">Timeline Source v2</div>
					<div className="text-muted-foreground truncate text-xs">
						{activeScene.name} · {lineCount} lines{isDirty ? " · modified" : ""}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<Button
						variant="ghost"
						size="icon"
						onClick={format}
						disabled={!sourceText || sourceUnavailable}
						aria-label="Format source"
					>
						<Braces className="size-4" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						onClick={copy}
						disabled={!sourceText}
						aria-label="Copy source"
					>
						<Copy className="size-4" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						onClick={reset}
						disabled={!session && issues.length === 0}
						aria-label="Reset source"
					>
						<RotateCcw className="size-4" />
					</Button>
				</div>
			</div>

			{isStale && (
				<div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
					<div className="flex items-start gap-2">
						<TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
						<span>The timeline changed. Reset before applying this draft.</span>
					</div>
				</div>
			)}

			<div className="min-h-0 flex-1 p-2">
				<Textarea
					value={sourceText}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
							event.preventDefault();
							apply();
						}
					}}
					wrap="off"
					spellCheck={false}
					readOnly={sourceUnavailable}
					aria-label="Editable Timeline Source v2"
					className="bg-muted/30 size-full min-h-0 resize-none overflow-auto whitespace-pre rounded-sm font-mono text-[11px] leading-5"
				/>
			</div>

			{(displayedIssues.length > 0 || notes.length > 0) && (
				<div className="max-h-32 shrink-0 overflow-y-auto border-t px-3 py-2 text-xs">
					{displayedIssues.map((issue) => (
						<div key={issue} className="text-destructive">
							{issue}
						</div>
					))}
					{notes.map((note) => (
						<div key={note} className="text-muted-foreground">
							{note}
						</div>
					))}
				</div>
			)}

			<div className="shrink-0 border-t p-3">
				<Button
					className="w-full"
					onClick={apply}
					disabled={!isDirty || isStale || sourceUnavailable}
				>
					<Check className="size-4" />
					Apply full source
				</Button>
				<div className="text-muted-foreground mt-1.5 text-center text-[10px]">
					Complete active scene + project settings · Undoable · Ctrl/⌘+Enter
				</div>
			</div>
		</div>
	);
}
