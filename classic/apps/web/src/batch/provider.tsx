"use client";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { batchEditIsLocked } from "opencut-wasm";
import type { EditorCore } from "@/core";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "@/components/ui/dialog";
import { useAiOAuthStatus } from "@/ai/components/use-ai-oauth-status";
import type { FullAutoOptions } from "@/ai/full-auto-edit";
import type { BatchRun, BatchState, BatchSource } from "./types";
import { batchRequest } from "./client";
import { setBatchReadOnlyProjects, beginAutomationHandoff } from "./read-only";
import { AutomationProgress } from "./automation-progress";
import { AutomationWorkerHost, type AutomationWorkerTask } from "./worker-host";
type StartProject = (input: {
	editor: EditorCore;
	options: FullAutoOptions;
}) => Promise<void>;
const Context = createContext<{
	state: BatchState;
	loaded: boolean;
	open: () => void;
	refresh: () => Promise<void>;
	startProject: StartProject;
	preparingProjectId: string | null;
}>({
	state: { runs: [] },
	loaded: false,
	open: () => {},
	refresh: async () => {},
	startProject: async () => {
		throw new Error("Automation host is not ready");
	},
	preparingProjectId: null,
});
export const useBatchEdit = () => useContext(Context);
export function BatchEditProvider({ children }: { children: ReactNode }) {
	const path = usePathname();
	if (path === "/batch-worker") return children;
	return <BatchEditHost>{children}</BatchEditHost>;
}
function BatchEditHost({ children }: { children: ReactNode }) {
	const [state, setState] = useState<BatchState>({ runs: [] });
	const [loaded, setLoaded] = useState(false);
	const [open, setOpen] = useState(false);
	const [files, setFiles] = useState<BatchSource[]>([]);
	const [options, setOptions] = useState<FullAutoOptions>({
		zoom: false,
		transitions: false,
		wordAnimation: false,
		music: false,
	});
	const [starting, setStarting] = useState(false);
	const [workers, setWorkers] = useState<AutomationWorkerTask[]>([]);
	const [preparingProjectId, setPreparingProjectId] = useState<string | null>(
		null,
	);
	const preparing = useRef(false);
	const requestVersion = useRef(0);
	const latestState = useRef<BatchState>({ runs: [] });
	const input = useRef<HTMLInputElement>(null);
	const { status, isLoading, login } = useAiOAuthStatus();
	const applyState = useCallback((value: BatchState) => {
		latestState.current = value;
		setBatchReadOnlyProjects(
			value.runs.flatMap((r) =>
				r.jobs
					.filter((j) => batchEditIsLocked({ status: j.status }))
					.map((j) => j.projectId),
			),
		);
		setState(value);
		setLoaded(true);
	}, []);
	const refresh = useCallback(async () => {
		const version = ++requestVersion.current;
		const value = await batchRequest();
		if (version === requestVersion.current) applyState(value);
	}, [applyState]);
	useEffect(() => {
		const poll = () => {
			void refresh().catch(() => {});
		};
		poll();
		const timer = setInterval(poll, 3000);
		return () => {
			clearInterval(timer);
		};
	}, [refresh]);
	useEffect(() => {
		// A crashed frame cannot send its finish message. Retire it after lease expiry.
		const expired = new Set(
			state.runs
				.filter(
					(r) =>
						r.jobs.some((j) => j.status === "interrupted") &&
						r.jobs.every((j) => !batchEditIsLocked({ status: j.status })),
				)
				.map((r) => r.id),
		);
		if (expired.size)
			setWorkers((prev) =>
				prev.some((w) => expired.has(w.run.id))
					? prev.filter((w) => !expired.has(w.run.id))
					: prev,
			);
	}, [state]);
	useEffect(() => {
		if (!workers.length && !preparingProjectId) return;
		const guard = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", guard);
		return () => window.removeEventListener("beforeunload", guard);
	}, [workers.length, preparingProjectId]);
	const launch = async (task: AutomationWorkerTask) => {
		// Publish the lock immediately, before the visible editor can write again.
		requestVersion.current++;
		applyState({
			...latestState.current,
			runs: [
				task.run,
				...latestState.current.runs.filter((r) => r.id !== task.run.id),
			],
		});
		setWorkers((prev) => [...prev, task]);
		void refresh().catch(() => {});
	};
	const checkModel = async () => {
		const response = await fetch("/api/transcription/whisper-cpp");
		const model = await response.json();
		if (!response.ok || !model.ivritLargeV3)
			throw new Error(
				"Configure ivrit-ai Whisper large-v3 before starting automatic editing",
			);
	};
	const startProject: StartProject = async ({ editor, options }) => {
		if (preparing.current)
			throw new Error(
				"Another project is being handed off. Please try again in a moment.",
			);
		const projectId = editor.project.getActive().metadata.id;
		const release = beginAutomationHandoff(projectId);
		preparing.current = true;
		setPreparingProjectId(projectId);
		try {
			await checkModel();
			await editor.save.flush();
			await editor.command.flushHistory();
			const project = editor.project.getActive();
			if (project.metadata.id !== projectId)
				throw new Error("Project changed before handoff. Nothing was queued.");
			const result = await batchRequest<{ run: BatchRun; token: string }>({
				action: "project",
				id: crypto.randomUUID(),
				projectId,
				expectedUpdatedAt: project.metadata.updatedAt.toISOString(),
				options,
			});
			await launch({ ...result, files: [] });
			toast.success("Full Auto Edit queued. You can work in another project.");
		} finally {
			release();
			preparing.current = false;
			setPreparingProjectId(null);
		}
	};
	const finishWorker = (id: string) => {
		setWorkers((prev) => prev.filter((w) => w.run.id !== id));
		void refresh().catch(() => {});
		toast.info(
			"Background run finished. Review each result in the activity panel.",
		);
	};
	const start = async () => {
		if (starting || !files.length) return;
		setStarting(true);
		try {
			await checkModel();
			const result = await batchRequest<{ run: BatchRun; token: string }>({
				action: "create",
				id: crypto.randomUUID(),
				files: files.map((f) => ({
					projectId: crypto.randomUUID(),
					fileName: f.name,
				})),
				options,
			});
			await launch({ ...result, files });
			setOpen(false);
			setFiles([]);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Could not start batch");
		} finally {
			setStarting(false);
		}
	};
	const cancel = async ({
		id,
		projectId,
	}: {
		id: string;
		projectId?: string;
	}) => {
		try {
			await batchRequest({ action: "cancel", id, projectId });
			await refresh();
		} catch (e) {
			toast.error(String(e));
		}
	};
	return (
		<Context.Provider
			value={{
				state,
				loaded,
				open: () => setOpen(true),
				refresh,
				startProject,
				preparingProjectId,
			}}
		>
			{children}
			{workers.map((worker) => (
				<AutomationWorkerHost
					key={worker.run.id}
					task={worker}
					onFinished={finishWorker}
				/>
			))}
			<AutomationProgress
				state={state}
				onOpenBatch={() => setOpen(true)}
				onCancel={cancel}
			/>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Batch · Full Auto Edit</DialogTitle>
						<DialogDescription>
							Choose videos. Each gets its own project with the same editing
							options.
						</DialogDescription>
					</DialogHeader>
					<div className="px-6 space-y-5">
						<input
							ref={input}
							type="file"
							accept="video/*,.mp4,.mov,.mkv,.webm,.m4v"
							multiple
							className="hidden"
							aria-label="Batch videos"
							onChange={(e) => {
								const next = Array.from(e.target.files ?? []);
								e.target.value = "";
								if (next.some((f) => f.size > 1_000_000_000)) {
									toast.error("For videos above 1 GB, use Import from drive");
									return;
								}
								setFiles((old) =>
									[...old, ...next].filter(
										(f, i, a) =>
											!(f instanceof File) ||
											a.findIndex(
												(x) =>
													f instanceof File &&
													x instanceof File &&
													x.name === f.name &&
													x.size === f.size &&
													x.lastModified === f.lastModified,
											) === i,
									),
								);
							}}
						/>
						<div className="flex gap-3">
							<Button
								variant="outline"
								disabled={starting}
								onClick={() => input.current?.click()}
							>
								Choose videos
							</Button>
							<Button
								variant="outline"
								disabled={starting}
								onClick={async () => {
									try {
										const picked = await batchRequest<BatchSource[]>({
											action: "pick",
										});
										setFiles((old) => [...old, ...picked]);
									} catch (e) {
										toast.error(String(e));
									}
								}}
							>
								Import from drive
							</Button>
						</div>
						{files.length > 0 && (
							<ul className="max-h-36 overflow-y-auto space-y-1 text-sm">
								{files.map((f, i) => (
									<li
										key={`${f.name}-${i}`}
										className="flex justify-between gap-3"
									>
										<span>{f.name}</span>
										<Button
											variant="text"
											size="sm"
											aria-label={`Remove ${f.name}`}
											onClick={() =>
												setFiles((v) => v.filter((_, n) => n !== i))
											}
										>
											Remove
										</Button>
									</li>
								))}
							</ul>
						)}
						<div className="grid gap-3 sm:grid-cols-2">
							{(
								[
									["zoom", "Automatic Zoom"],
									["transitions", "Automatic Transition Edit"],
									["wordAnimation", "Automatic Word Animation and Reveal"],
									["music", "Automatic Music"],
								] as const
							).map(([key, label]) => (
								<label key={key} className="flex items-center gap-3 text-sm">
									<Checkbox
										checked={options[key]}
										disabled={starting}
										onCheckedChange={(v) =>
											setOptions((p) => ({ ...p, [key]: v === true }))
										}
									/>
									{label}
								</label>
							))}
						</div>
						<p className="text-xs text-muted-foreground">
							Always included: vertical cover, local face/body centering,
							silence removal at 0.3s, Hebrew ivrit-ai large-v3, 1-row Auto
							Texts, Assistant bold, centered captions, hidden punctuation, fade
							60% / 25% and black edge feather.
						</p>
						<p className="text-xs text-muted-foreground">
							You can keep using the app. Automatic edits show live progress and
							stay read-only until their job stops. Keep this app tab open while
							editing runs. You can add more projects to the queue.
						</p>
						{!isLoading && !status.authenticated && (
							<Button variant="outline" onClick={login}>
								Log in to AI to start
							</Button>
						)}
						{state.runs
							.filter(
								(r, i) =>
									i < 10 ||
									r.jobs.some((j) => batchEditIsLocked({ status: j.status })),
							)
							.map((run) => (
								<section key={run.id} className="space-y-2 border-t pt-4">
									<div className="flex justify-between items-center">
										<h3 className="text-sm font-medium">
											{run.jobs.length} projects ·{" "}
											{new Date(run.updatedAt).toLocaleDateString()}
										</h3>
										{run.jobs.some((j) =>
											batchEditIsLocked({ status: j.status }),
										) && (
											<Button
												variant="text"
												onClick={() => cancel({ id: run.id })}
											>
												Cancel remaining
											</Button>
										)}
									</div>
									<p className="text-xs text-muted-foreground">
										{Object.entries(run.options)
											.filter(([, v]) => v)
											.map(
												([k]) =>
													({
														zoom: "Zoom",
														transitions: "Transitions",
														wordAnimation: "Word animation & reveal",
														music: "Music",
													})[k],
											)
											.join(" · ") || "Basic Full Auto Edit"}
									</p>
									{run.jobs.map((job) => (
										<div
											key={job.projectId}
											className="rounded-md border p-3 text-sm space-y-1"
										>
											<div className="flex items-center justify-between gap-3">
												<span className="font-medium">{job.fileName}</span>
												<span>{job.status}</span>
											</div>
											<p
												role="status"
												className="text-xs text-muted-foreground whitespace-pre-wrap"
											>
												{job.message}
											</p>
											<div className="flex gap-4">
												{job.created && (
													<Link
														href={`/editor/${job.projectId}`}
														onClick={() => setOpen(false)}
														className="text-xs underline"
													>
														{batchEditIsLocked({ status: job.status })
															? "View live · read-only"
															: "Open project"}
													</Link>
												)}
												{batchEditIsLocked({ status: job.status }) && (
													<button
														disabled={job.cancelRequested}
														className="text-xs underline disabled:opacity-50"
														onClick={() =>
															cancel({ id: run.id, projectId: job.projectId })
														}
													>
														{job.cancelRequested ? "Cancelling…" : "Cancel"}
													</button>
												)}
											</div>
										</div>
									))}
								</section>
							))}
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setOpen(false)}>
							Close
						</Button>
						<Button
							disabled={
								!loaded || starting || !files.length || !status.authenticated
							}
							onClick={start}
						>
							{starting
								? "Starting…"
								: `Start Full Auto Edit · ${files.length} videos`}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Context.Provider>
	);
}
export function BatchEditButton() {
	const batch = useBatchEdit();
	return (
		<Button size="lg" variant="outline" onClick={batch.open}>
			Batch
		</Button>
	);
}

export function BatchProjectBadge({ projectId }: { projectId: string }) {
	const { state } = useBatchEdit();
	const job = state.runs
		.flatMap((r) => r.jobs)
		.find((j) => j.projectId === projectId);
	return job ? (
		<span
			className="block text-xs text-muted-foreground truncate"
			title={job.message}
		>
			Auto Edit · {batchEditIsLocked({ status: job.status }) ? "Locked · " : ""}
			{job.status}
		</span>
	) : null;
}
