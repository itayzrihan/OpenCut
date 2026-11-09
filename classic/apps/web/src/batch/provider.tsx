"use client";
import {
	Message as UiMessage,
	LocalizedElement as UiLocalized,
} from "@/i18n/message";
import { useInterfaceLanguage } from "@/i18n/provider";
import { openSceneWorker, sceneWorkerUrl } from "./window-worker";
import { EditorCore as BackgroundEditor } from "@/core";
import {
	enqueueScenes,
	publishSceneResults,
	queueOwner,
	type SceneAction,
} from "./scene-jobs";
import { BrandKitPicker } from "@/brand-kits/picker";
import { BrowserTranscriptionPicker } from "@/transcription/browser-model-picker";
import {
	BROWSER_TRANSCRIPTION_LABELS,
	DEFAULT_BROWSER_TRANSCRIPTION_MODEL,
} from "@/transcription/models";
import { Clapperboard, FolderOpen, Sparkles } from "lucide-react";
import brand from "@/components/landing/pocut-brand.module.css";
import { cn } from "@/utils/ui";
import { assertBrowserTranscriptionAvailable } from "@/services/transcription/service";
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
import { toast } from "@/i18n/toast";
import { batchEditIsLocked } from "opencut-wasm";
import type { EditorCore } from "@/core";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogBody,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "@/components/ui/dialog";
import { useAiOAuthStatus } from "@/ai/components/use-ai-oauth-status";
import type { FullAutoOptions } from "@/ai/full-auto-edit";
import type { BatchRun, BatchState, BatchSource } from "./types";
import { batchRequest } from "./client";
import { setBatchReadOnlyProjects } from "./read-only";
import { AutomationProgress } from "./automation-progress";
import { AutomationWorkerHost, type AutomationWorkerTask } from "./worker-host";
import { createWorkerReadiness } from "./worker-readiness";
import { batchStatusLabels } from "./progress-view";
type StartProject = (input: {
	sceneIds?: string[];
	action?: SceneAction;
	resumeRunId?: string;
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
	if (path === "/batch-worker" || path === "/render-queue") return children;
	return <BatchEditHost>{children}</BatchEditHost>;
}
function BatchEditHost({ children }: { children: ReactNode }) {
	const { t, locale } = useInterfaceLanguage();
	const [state, setState] = useState<BatchState>({ runs: [] });
	const [loaded, setLoaded] = useState(false);
	const [polledAt, setPolledAt] = useState(0);
	const [open, setOpen] = useState(false);
	const [files, setFiles] = useState<BatchSource[]>([]);
	const [options, setOptions] = useState<FullAutoOptions>({
		zoom: false,
		transitions: false,
		wordAnimation: false,
		music: false,
		soundEffects: false,
		browserModel: DEFAULT_BROWSER_TRANSCRIPTION_MODEL,
	});
	const [starting, setStarting] = useState(false);
	const [workers, setWorkers] = useState<
		Array<AutomationWorkerTask & { hostKey: string }>
	>([]);
	const [idleHostKey, setIdleHostKey] = useState(() => crypto.randomUUID());
	const preparingProjectId = null;
	const preparing = useRef(false);
	const [workerReadiness] = useState(createWorkerReadiness);
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
		setPolledAt(Date.now());
		setLoaded(true);
	}, []);
	const refresh = useCallback(async () => {
		const version = ++requestVersion.current;
		const value = await batchRequest();
		if (version === requestVersion.current) applyState(value);
	}, [applyState]);
	useEffect(() => {
		let pending = false;
		const poll = () => {
			// A slow startup request must finish before the next poll. Otherwise
			// each poll invalidates the previous response and loaded stays false.
			if (pending) return;
			pending = true;
			void refresh()
				.catch(() => {})
				.finally(() => {
					pending = false;
				});
		};
		poll();
		const timer = setInterval(poll, 3000);
		return () => {
			clearInterval(timer);
		};
	}, [refresh]);
	useEffect(() => {
		// Terminal jobs have already saved/released ownership (or never started).
		// Retire their frames even if a cancelled worker cannot send its finish message.
		const expired = new Set(
			state.runs
				.filter((r) =>
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
		// Promote the already-loaded iframe without navigating it again.
		const hostKey = idleHostKey;
		setIdleHostKey(crypto.randomUUID());
		setWorkers((prev) => [...prev, { ...task, hostKey }]);
		void refresh().catch(() => {});
	};
	const workerRef = useRef(workers);
	const launchRef = useRef(launch);
	useEffect(() => {
		workerRef.current = workers;
		launchRef.current = launch;
	});
	useEffect(() => {
		let stopped = false,
			pending = false;
		const recover = async () => {
			if (pending) return;
			pending = true;
			try {
				const task = await batchRequest<AutomationWorkerTask | null>({
					action: "recover",
					executor: "iframe",
					ownerId: queueOwner(),
					activeRunId: workerRef.current[0]?.run.id,
				});
				if (task && !stopped && !workerRef.current.length)
					await launchRef.current(task);
				if (!stopped)
					await publishSceneResults({
						editor: BackgroundEditor.getInstance(),
						runs: latestState.current.runs,
					});
			} catch (error) {
				console.warn("Scene automation recovery/publication", error);
			} finally {
				pending = false;
			}
		};
		void recover();
		const timer = setInterval(() => void recover(), 3000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, []);
	const checkModel = async () => {
		assertBrowserTranscriptionAvailable();
	};
	const startProject: StartProject = async ({
		editor,
		options,
		sceneIds,
		resumeRunId,
		action = "full-auto",
	}) => {
		if (preparing.current)
			throw new Error("Saving another scene selection. Try again in a moment.");
		preparing.current = true;
		openSceneWorker({ runs: latestState.current.runs });
		try {
			if (action === "full-auto" || action === "auto-texts") await checkModel();
			const value = resumeRunId
				? await batchRequest({
						action: "retry",
						id: resumeRunId,
						ownerId: queueOwner(),
					})
				: await enqueueScenes({
						editor,
						sceneIds: sceneIds ?? [editor.scenes.getActiveScene().id],
						action,
						options,
					});
			applyState(value);
			toast.success("Scene edits queued. You can continue in any scene.");
		} finally {
			preparing.current = false;
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
			await workerReadiness.wait();
			const result = await batchRequest<{ run: BatchRun; token: string }>({
				action: "create",
				id: crypto.randomUUID(),
				files: files.map((f) => ({
					projectId: crypto.randomUUID(),
					fileName: f.name,
				})),
				options: {
					zoom: options.zoom,
					transitions: options.transitions,
					wordAnimation: options.wordAnimation,
					music: options.music,
					soundEffects: options.soundEffects ?? false,
					...(options.brandKitId ? { brandKitId: options.brandKitId } : {}),
				},
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
			{workers.length
				? workers.map((worker) => (
						<AutomationWorkerHost
							key={worker.hostKey}
							task={worker}
							onFinished={finishWorker}
							onReady={workerReadiness.markReady}
						/>
					))
				: [
						<AutomationWorkerHost
							key={idleHostKey}
							onFinished={finishWorker}
							onReady={workerReadiness.markReady}
						/>,
					]}
			<AutomationProgress
				state={state}
				onOpenBatch={() => setOpen(true)}
				onCancel={cancel}
			/>

			{state.runs.some(
				(r) =>
					r.executor === "window" &&
					r.jobs.some((j) => ["ready", "running"].includes(j.status)),
			) &&
				!state.runs.some(
					(r) =>
						r.executor === "window" &&
						r.workerHeartbeatAt &&
						polledAt - r.workerHeartbeatAt < 180_000 &&
						r.jobs.some((j) => ["ready", "running"].includes(j.status)),
				) && (
					<a
						href={sceneWorkerUrl()}
						target="_blank"
						rel="noopener noreferrer"
						className="fixed bottom-3 right-3 z-50 rounded border bg-background px-3 py-1 text-xs"
					>
						<UiMessage text={"Open background editor"} />
					</a>
				)}

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent
					className={cn(
						brand.theme,
						"flex max-h-[min(90dvh,840px)] max-w-3xl flex-col overflow-hidden rounded-2xl",
					)}
				>
					<DialogHeader className="shrink-0 px-5 py-5 pe-14 sm:px-7 sm:pe-16">
						<p
							className={cn(
								brand.eyebrow,
								"flex items-center gap-2 text-primary",
							)}
						>
							<Sparkles className="size-4" aria-hidden="true" />{" "}
							<UiMessage text={"POCUT Studio"} />
						</p>
						<DialogTitle className="text-xl leading-tight">
							<UiMessage text={"Batch · Full Auto Edit"} />
						</DialogTitle>
						<DialogDescription>
							<UiMessage
								text={
									"Choose videos. Each gets its own project with the same editing options."
								}
							/>
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="scrollbar-thin min-h-0 gap-5 overflow-y-auto px-5 py-5 sm:px-7">
						<UiLocalized<"input">
							element={"input"}
							messageProps={["aria-label"]}
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
						<section
							aria-labelledby="batch-source-title"
							className="grid gap-3 rounded-xl border bg-background/40 p-4 sm:grid-cols-[auto_1fr] sm:items-center"
						>
							<h3 id="batch-source-title" className="text-sm font-semibold">
								<UiMessage text={"Source videos"} />
							</h3>
							<div className="flex flex-wrap gap-2 sm:justify-end">
								<Button
									variant="outline"
									disabled={starting}
									onClick={() => input.current?.click()}
								>
									<Clapperboard aria-hidden="true" />{" "}
									<UiMessage text={"Choose videos"} />
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
									<FolderOpen aria-hidden="true" />{" "}
									<UiMessage text={"Import from drive"} />
								</Button>
							</div>
							{files.length > 0 && (
								<ul className="max-h-36 divide-y overflow-y-auto rounded-lg border px-3 text-sm sm:col-span-2">
									{files.map((f, i) => (
										<li
											key={`${f.name}-${i}`}
											className="flex items-center justify-between gap-3 py-1.5"
										>
											<span className="min-w-0 break-words">{f.name}</span>
											<Button
												variant="text"
												size="sm"
												aria-label={t("Remove {v0}", { v0: f.name })}
												onClick={() =>
													setFiles((v) => v.filter((_, n) => n !== i))
												}
											>
												<UiMessage text={"Remove"} />
											</Button>
										</li>
									))}
								</ul>
							)}
						</section>
						<div className="grid gap-3 sm:grid-cols-2">
							<BrowserTranscriptionPicker
								value={options.browserModel}
								disabled={starting}
								onChange={(browserModel) =>
									setOptions((previous) => ({ ...previous, browserModel }))
								}
							/>
							<BrandKitPicker
								value={options.brandKitId}
								disabled={starting}
								onChange={(brandKitId) =>
									setOptions((previous) => ({ ...previous, brandKitId }))
								}
							/>
						</div>
						<fieldset className="rounded-xl border bg-background/40 px-4 pb-4">
							<legend className="px-1 text-sm font-semibold">
								<UiMessage text={"Optional finishing steps"} />
							</legend>
							<div className="grid gap-1.5 pt-2 sm:grid-cols-2">
								{(
									[
										["zoom", "Automatic Zoom"],
										["transitions", "Automatic Transition Edit"],
										["wordAnimation", "Automatic Word Animation and Reveal"],
										["soundEffects", "Automatic Sound Effects · Earshot"],
										["music", "Automatic Music"],
									] as const
								).map(([key, label]) => (
									<label
										key={key}
										className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1 text-sm hover:bg-accent"
									>
										<Checkbox
											checked={options[key]}
											disabled={starting}
											onCheckedChange={(v) =>
												setOptions((p) => ({ ...p, [key]: v === true }))
											}
										/>
										{t(label)}
									</label>
								))}
							</div>
						</fieldset>
						<div className="grid gap-2 rounded-xl border bg-accent/40 p-4 text-xs leading-relaxed text-muted-foreground">
							<p>
								<strong className="font-semibold text-foreground">
									<UiMessage text={"Always included"} />
								</strong>{" "}
								<UiMessage
									text={
										"· Vertical framing, silence removal, and centered single-row captions."
									}
								/>
							</p>
							<p>
								<UiMessage
									text={
										"Keep this tab open during video imports. Scene edits run in the Background Edits window, which you can minimize while you work. You can add more jobs to the queue."
									}
								/>
							</p>
						</div>
						{!isLoading && !status.authenticated && (
							<Button variant="outline" onClick={login}>
								<UiMessage text={"Log in to AI to start"} />
							</Button>
						)}
						{state.runs
							.filter(
								(r, i) =>
									i < 10 ||
									r.jobs.some((j) => batchEditIsLocked({ status: j.status })),
							)
							.map((run) => (
								<section key={run.id} className="grid gap-3 border-t pt-5">
									<div className="flex flex-wrap items-center justify-between gap-2">
										<h3 className="text-sm font-medium">
											{run.jobs.length} <UiMessage text={"projects ·"} />{" "}
											{new Date(run.updatedAt).toLocaleDateString()}
										</h3>
										{run.jobs.some((j) =>
											batchEditIsLocked({ status: j.status }),
										) && (
											<Button
												variant="text"
												onClick={() => cancel({ id: run.id })}
											>
												<UiMessage text={"Cancel remaining"} />
											</Button>
										)}
									</div>
									<p className="text-xs text-muted-foreground">
										{Object.entries(run.options)
											.filter(([, v]) => v === true)
											.map(
												([k]) =>
													({
														zoom: "Zoom",
														transitions: "Transitions",
														wordAnimation: "Word animation & reveal",
														music: "Music",
														soundEffects: "Earshot sound effects",
													})[k],
											)
											.join(" · ") || (
											<UiMessage text={"Basic Full Auto Edit"} />
										)}
										{run.options.browserModel
											? ` · ${BROWSER_TRANSCRIPTION_LABELS[run.options.browserModel]}`
											: ""}
										{run.options.brandKit ? (
											<UiMessage
												text={" · Brand Kit: {v0}"}
												values={{ v0: String(run.options.brandKit.name) }}
											/>
										) : (
											""
										)}
									</p>
									{run.jobs.map((job) => (
										<div
											key={job.projectId}
											className="grid gap-2 rounded-xl border bg-background/40 p-4 text-sm"
										>
											<div className="flex items-center justify-between gap-3">
												<span className="min-w-0 break-words font-medium">
													{job.fileName}
												</span>
												<span>{t(batchStatusLabels[job.status])}</span>
											</div>
											<p
												role="status"
												className="text-xs text-muted-foreground whitespace-pre-wrap"
											>
												{job.message && t(job.message)}
											</p>
											<div className="flex flex-wrap gap-4">
												{job.sourceProjectId &&
													["failed", "interrupted"].includes(job.status) && (
														<button
															className="text-xs underline"
															onClick={() => {
																openSceneWorker({ runs: state.runs });
																void batchRequest({
																	action: "retry",
																	id: run.id,
																	ownerId: queueOwner(),
																})
																	.then(refresh)
																	.catch((e) => toast.error(String(e)));
															}}
														>
															<UiMessage text={"Resume saved edit"} />
														</button>
													)}
												{job.created && (
													<Link
														href={`/editor/${job.sourceProjectId ?? job.projectId}`}
														onClick={() => setOpen(false)}
														className="text-xs underline"
													>
														{job.sourceProjectId ? (
															<UiMessage text={"Open source · editable"} />
														) : batchEditIsLocked({ status: job.status }) ? (
															<UiMessage text={"View live · read-only"} />
														) : (
															<UiMessage text={"Open project"} />
														)}
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
														{job.cancelRequested ? (
															<UiMessage text={"Cancelling…"} />
														) : (
															<UiMessage text={"Cancel"} />
														)}
													</button>
												)}
											</div>
										</div>
									))}
								</section>
							))}
					</DialogBody>
					<DialogFooter className="shrink-0 px-5 py-4 sm:items-center sm:px-7">
						<p
							className="order-last text-xs text-muted-foreground sm:order-first sm:me-auto"
							aria-live="polite"
						>
							{files.length ? (
								files.length === 1 ? (
									t("One video selected")
								) : (
									t("Selected videos: {v0}", {
										v0: new Intl.NumberFormat(locale).format(files.length),
									})
								)
							) : (
								<UiMessage text={"No videos selected"} />
							)}
						</p>
						<Button variant="outline" onClick={() => setOpen(false)}>
							<UiMessage text={"Close"} />
						</Button>
						<Button
							disabled={
								!loaded || starting || !files.length || !status.authenticated
							}
							className={brand.primary}
							onClick={start}
						>
							{starting ? (
								<UiMessage text={"Starting…"} />
							) : (
								<UiMessage text={"Start Full Auto Edit"} />
							)}
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
			<UiMessage text={"Batch"} />
		</Button>
	);
}

export function BatchProjectBadge({ projectId }: { projectId: string }) {
	const { t } = useInterfaceLanguage();
	const { state } = useBatchEdit();
	const job = state.runs
		.flatMap((r) => r.jobs)
		.find((j) => j.projectId === projectId);
	return job ? (
		<span
			className="block text-xs text-muted-foreground truncate"
			title={job.message && t(job.message)}
		>
			<UiMessage text={"Auto Edit ·"} />{" "}
			{batchEditIsLocked({ status: job.status }) ? (
				<>
					<UiMessage text={"Locked ·"} />{" "}
				</>
			) : (
				""
			)}
			{t(batchStatusLabels[job.status])}
		</span>
	) : null;
}
