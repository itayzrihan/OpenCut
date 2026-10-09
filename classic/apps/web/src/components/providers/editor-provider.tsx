"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { EditorCore } from "@/core";
import { useEditor, useEditorProject } from "@/editor/use-editor";
import { useKeybindingsListener } from "@/actions/use-keybindings";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { useTimelineStore } from "@/timeline/timeline-store";
import { useEditorActions } from "@/actions/use-editor-actions";
import { loadFontAtlas } from "@/fonts/google-fonts";
import {
	initializeGpuRenderer,
	isGpuAvailable,
} from "@/services/renderer/gpu-renderer";
import { createReplacementProjectIfMissing } from "@/editor/project-loading";
import { ClassicMcpBridge } from "@/mcp/classic-mcp-bridge";

interface EditorProviderProps {
	projectId: string;
	children: React.ReactNode;
	readOnly?: boolean;
}

export function EditorProvider({
	projectId,
	children,
	readOnly = false,
}: EditorProviderProps) {
	const activeProject = useEditorProject((e) => e.project.getActiveOrNull());
	const replacingProject = useEditorProject((e) => e.project.getIsLoading());
	const sessionReadOnly = useEditorProject((e) =>
		e.project.getSessionReadOnlyReason(),
	);
	const [takingOwnership, setTakingOwnership] = useState(false);
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { setLoadingProject } = useKeybindingsStore();

	useEffect(() => {
		setLoadingProject(isLoading || replacingProject || takingOwnership);
	}, [isLoading, replacingProject, takingOwnership, setLoadingProject]);

	useEffect(() => {
		let cancelled = false;
		const editor = EditorCore.getInstance();

		const loadProject = async () => {
			try {
				setError(null);
				if (!readOnly && editor.project.canReuseLoadedProject(projectId)) {
					setIsLoading(false);
					return;
				}
				// A handoff changes ownership, not the visible project. Keep its
				// preview mounted while the isolated worker edits the saved copy.
				if (readOnly && editor.project.observeBatchPreview({ id: projectId })) {
					setIsLoading(false);
					return;
				}
				setIsLoading(true);
				const gpuInitialization = initializeGpuRenderer();
				const projectLoad = editor.project.loadProject({ id: projectId });
				const [projectExists] = await Promise.all([
					projectLoad,
					gpuInitialization,
				]);
				editor.renderer.setDegraded(!isGpuAvailable());

				if (cancelled) return;

				const replacementProjectId = await createReplacementProjectIfMissing({
					projectExists,
					createProject: () =>
						editor.project.createNewProject({
							name: "Untitled Project",
						}),
				});
				if (replacementProjectId) {
					if (!cancelled) {
						router.replace(`/editor/${replacementProjectId}`);
					}
					return;
				}

				setIsLoading(false);
				loadFontAtlas();
			} catch (err) {
				if (cancelled) return;

				const wasmPanic = (window as Window & { __wasmPanic?: string })
					.__wasmPanic;
				if (wasmPanic) {
					delete (window as Window & { __wasmPanic?: string }).__wasmPanic;
					setError(wasmPanic);
				} else {
					setError(
						err instanceof Error ? err.message : "Failed to load project",
					);
				}
				setIsLoading(false);
			}
		};

		loadProject();

		return () => {
			cancelled = true;
		};
	}, [projectId, router, readOnly]);

	useEffect(() => {
		if (!readOnly) return;
		let busy = false;
		const timer = setInterval(async () => {
			if (busy) return;
			busy = true;
			try {
				await EditorCore.getInstance().project.refreshBatchPreview({
					id: projectId,
				});
			} catch (error) {
				console.warn("Batch preview refresh failed", error);
			} finally {
				busy = false;
			}
		}, 5000);
		return () => clearInterval(timer);
	}, [projectId, readOnly]);

	if (error) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<p className="text-destructive text-sm">{error}</p>
				</div>
			</div>
		);
	}

	if (isLoading || replacingProject || takingOwnership) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Loading project...</p>
				</div>
			</div>
		);
	}

	if (!activeProject) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Exiting project...</p>
				</div>
			</div>
		);
	}

	return (
		<>
			{!readOnly && !sessionReadOnly && <EditorRuntimeBindings />}
			{sessionReadOnly && !readOnly && (
				<div className="fixed top-0 inset-x-0 z-100 flex items-center justify-between gap-4 border-b bg-background p-3 text-sm">
					<span role="status">{sessionReadOnly}</span>
					<button
						type="button"
						className="shrink-0 underline"
						disabled={takingOwnership}
						onClick={() => {
							setTakingOwnership(true);
							void EditorCore.getInstance()
								.project.takeOverEditorSession()
								.catch((err) => {
									setError(
										err instanceof Error
											? err.message
											: "Could not acquire editor ownership",
									);
								})
								.finally(() => setTakingOwnership(false));
						}}
					>
						{takingOwnership
							? "Opening latest version…"
							: "Take ownership and open latest saved version"}
					</button>
				</div>
			)}
			<div className="contents" inert={!!sessionReadOnly}>
				{children}
			</div>
		</>
	);
}

function EditorRuntimeBindings() {
	const editor = useEditor();
	const rippleEditingEnabled = useTimelineStore(
		(state) => state.rippleEditingEnabled,
	);

	useEffect(() => {
		editor.command.isRippleEnabled = rippleEditingEnabled;
	}, [editor, rippleEditingEnabled]);

	useEffect(() => {
		const flushPendingSave = (reason: string) => {
			if (!editor.save.getIsDirty()) return;
			void editor.save.flush().catch((error) => {
				console.error(`Failed to flush project during ${reason}:`, error);
			});
		};

		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!editor.save.getIsDirty()) return;
			flushPendingSave("beforeunload");
			event.preventDefault();
			(event as unknown as { returnValue: string }).returnValue = "";
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === "hidden") {
				flushPendingSave("visibility change");
			}
		};
		const handlePageHide = () => {
			flushPendingSave("pagehide");
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		window.addEventListener("pagehide", handlePageHide);
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			window.removeEventListener("beforeunload", handleBeforeUnload);
			window.removeEventListener("pagehide", handlePageHide);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [editor]);

	useEditorActions();
	useKeybindingsListener();
	return <ClassicMcpBridge editor={editor} />;
}
