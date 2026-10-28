"use client";
import { useEffect, useRef, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogBody,
	DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { Download, ListPlus } from "lucide-react";
import {
	ExportSettingsFields,
	ExportPlanSummary,
	type ExportSettingsValue,
} from "./settings-fields";
import { projectExportRequest } from "./library-client";
import { checkExportEncoder } from "./video-encoding";
import { openRenderQueue, renderQueueRequest } from "./queue/client";
import type { SavedExportInfo } from "./library-server";
import type { RenderJob } from "./queue/types";
import type { RenderJobView } from "./queue/types";
type Row = {
	id: string;
	sceneId?: string;
	override?: ExportSettingsValue;
	info?: SavedExportInfo;
	error?: string;
	checking?: boolean;
};
type Entry = { id: string; destination: FileSystemFileHandle };
const defaults: ExportSettingsValue = {
	format: "mp4",
	quality: "very_high",
	preferences: { resolution: "source", encoding: "compact" },
	includeAudio: true,
};
const terminal = (job: RenderJobView) =>
	["completed", "failed", "cancelled"].includes(job.status);
export function ProjectsExportDialog({
	projectIds,
	onClose,
}: {
	projectIds: string[];
	onClose: () => void;
}) {
	const [common, setCommon] = useState(defaults);
	const [refreshToken, setRefreshToken] = useState(0);
	const [rows, setRows] = useState<Row[]>(() =>
		projectIds.map((id) => ({ id, checking: true })),
	);
	const [submitting, setSubmitting] = useState(false);
	const [entries, setEntries] = useState<Entry[]>([]);
	const [workerIndex, setWorkerIndex] = useState(0);
	const [jobs, setJobs] = useState<RenderJobView[]>([]);
	const [error, setError] = useState<string>();
	const submissionIds = useRef(new Map<string, string>());
	const submitted = useRef(new Set<string>());
	const activeEntry = entries[workerIndex];
	const busy = submitting || !!activeEntry;
	const key = JSON.stringify({
		refreshToken,
		common,
		rows: rows.map(({ id, sceneId, override }) => ({ id, sceneId, override })),
	});
	useEffect(() => {
		let stale = false;
		setRows((old) =>
			old.map((r) => ({ ...r, checking: true, error: undefined })),
		);
		const timer = setTimeout(() => {
			void Promise.all(
				rows.map(async (row) => {
					try {
						const info = await projectExportRequest({
							action: "inspect",
							projectId: row.id,
							sceneId: row.sceneId,
							options: row.override ?? common,
						});
						const encoderError = await checkExportEncoder(info.plan);
						if (!stale)
							setRows((old) =>
								old.map((r) =>
									r.id === row.id
										? {
												...r,
												info,
												checking: false,
												error: encoderError ?? undefined,
											}
										: r,
								),
							);
					} catch (e) {
						if (!stale)
							setRows((old) =>
								old.map((r) =>
									r.id === row.id
										? {
												...r,
												checking: false,
												error: e instanceof Error ? e.message : String(e),
											}
										: r,
								),
							);
					}
				}),
			);
		}, 200);
		return () => {
			stale = true;
			clearTimeout(timer);
		};
	}, [key]);
	useEffect(() => {
		if (!entries.length) return;
		let stale = false;
		const refresh = async () => {
			try {
				const state = await renderQueueRequest();
				if (!stale)
					setJobs(state.jobs.filter((j) => entries.some((e) => e.id === j.id)));
			} catch (e) {
				if (!stale) setError(String(e));
			}
		};
		const timer = setInterval(() => void refresh(), 1500);
		void refresh();
		return () => {
			stale = true;
			clearInterval(timer);
		};
	}, [entries]);
	useEffect(() => {
		if (!activeEntry) return;
		const id = activeEntry.id;
		let stopped = false;
		const preventClose = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", preventClose);
		void (async () => {
			let editor: import("@/core").EditorCore | undefined;
			let claimed: RenderJob | undefined;
			try {
				const [{ executeQueuedRender }, { EditorCore }] = await Promise.all([
					import("./queue/worker"),
					import("@/core"),
				]);
				for (;;) {
					if (stopped) break;
					const state = await renderQueueRequest();
					const current = state.jobs.find((j) => j.id === id);
					if (!current || terminal(current)) break;
					const job = await renderQueueRequest<RenderJob | null>({
						action: "claim",
						attempt: crypto.randomUUID(),
						jobId: id,
					});
					if (job) {
						claimed = job;
						editor = EditorCore.createRenderInstance();
						await executeQueuedRender(
							job,
							() => {},
							activeEntry.destination,
							editor,
						);
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 1500));
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				setError(detail);
				if (claimed)
					await renderQueueRequest({
						action: "report",
						id: claimed.id,
						projectId: claimed.projectId,
						attempt: claimed.attempt,
						progress: 0,
						status: "failed",
						message: detail.slice(0, 4000),
					}).catch(() => {});
				await cancel();
			} finally {
				try {
					editor?.disposeRenderInstance();
				} catch (error) {
					setError(String(error));
				}
				if (!stopped)
					setWorkerIndex((i) => (entries[i]?.id === id ? i + 1 : i));
			}
		})();
		return () => {
			stopped = true;
			window.removeEventListener("beforeunload", preventClose);
		};
	}, [activeEntry?.id]);

	const ready = rows.every((r) => r.info && !r.checking && !r.error);
	const remaining = rows.filter((r) => !submitted.current.has(r.id));
	async function start(delivery: "queue" | "direct") {
		if (!ready || busy || !remaining.length) return;
		setError(undefined);
		const destinations = new Map<string, FileSystemFileHandle>();
		// Native pickers must be called directly from this user gesture.
		try {
			if (delivery === "direct") {
				const host = window as Window & {
					showSaveFilePicker?: (
						options: unknown,
					) => Promise<FileSystemFileHandle>;
					showDirectoryPicker?: (
						options: unknown,
					) => Promise<FileSystemDirectoryHandle>;
				};
				if (remaining.length === 1) {
					const row = remaining[0],
						info = row.info!,
						format = info.options.format;
					if (!host.showSaveFilePicker)
						throw Error(
							"Direct export requires Chrome or the desktop app. You can use Render Queue instead.",
						);
					destinations.set(
						row.id,
						await host.showSaveFilePicker({
							suggestedName: outputName(info),
							types: [
								{
									description: format.toUpperCase(),
									accept: {
										[format === "mp4" ? "video/mp4" : "video/webm"]: [
											`.${format}`,
										],
									},
								},
							],
						}),
					);
				} else {
					if (!host.showDirectoryPicker)
						throw Error(
							"Choose Render Queue or use Chrome to export multiple files to a folder.",
						);
					const folder = await host.showDirectoryPicker({ mode: "readwrite" });
					for (const row of remaining) {
						const name = outputName(row.info!);
						let candidate = name,
							index = 1;
						for (;;) {
							try {
								await folder.getFileHandle(candidate);
								candidate = name.replace(/\.(mp4|webm)$/, ` (${index++}).$1`);
							} catch (e) {
								if (e instanceof DOMException && e.name === "NotFoundError")
									break;
								throw e;
							}
							if (index > 1000)
								throw Error(
									"Choose an export folder with fewer matching filenames",
								);
						}
						destinations.set(
							row.id,
							await folder.getFileHandle(candidate, { create: true }),
						);
					}
				}
			} else openRenderQueue();
		} catch (e) {
			if (!(e instanceof DOMException && e.name === "AbortError"))
				setError(e instanceof Error ? e.message : String(e));
			return;
		}
		setSubmitting(true);
		const created: RenderJobView[] = [],
			direct: Entry[] = [];
		for (const row of remaining) {
			try {
				let id = submissionIds.current.get(row.id);
				if (!id) {
					id = crypto.randomUUID();
					submissionIds.current.set(row.id, id);
				}
				const job = await projectExportRequest<RenderJobView>({
					action: "enqueue",
					id,
					projectId: row.id,
					sceneId: row.info!.sceneId,
					expectedStorageRevision: row.info!.storageRevision,
					options: row.info!.options,
					delivery,
					...(delivery === "direct"
						? { destinationName: destinations.get(row.id)!.name }
						: {}),
				});
				submitted.current.add(row.id);
				created.push(job);
				if (delivery === "direct")
					direct.push({ id: job.id, destination: destinations.get(row.id)! });
			} catch (e) {
				setRows((old) =>
					old.map((r) =>
						r.id === row.id
							? { ...r, error: e instanceof Error ? e.message : String(e) }
							: r,
					),
				);
			}
		}
		setJobs(created);
		setSubmitting(false);
		if (delivery === "direct" && direct.length) {
			setEntries(direct);
			setWorkerIndex(0);
		} else if (created.length === remaining.length) {
			toast.success(
				`${created.length} project${created.length === 1 ? "" : "s"} added to Render Queue`,
			);
			onClose();
		}
	}
	async function cancel() {
		try {
			for (const entry of entries.slice(workerIndex)) {
				const state = await renderQueueRequest();
				const job = state.jobs.find((j) => j.id === entry.id);
				if (job && !terminal(job))
					await renderQueueRequest({
						action: "cancel",
						id: job.id,
						projectId: job.projectId,
						expectedRevision: state.revision,
					});
			}
		} catch (e) {
			setError(String(e));
		}
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy) onClose();
			}}
		>
			<DialogContent className="max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
				<DialogHeader className="shrink-0">
					<DialogTitle>
						Export{" "}
						{projectIds.length === 1
							? "project"
							: `${projectIds.length} projects`}
					</DialogTitle>
					<DialogDescription>
						Choose a scene and export settings for each project. Exports use the
						latest saved version; save any changes in the editor first.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="overflow-y-auto min-h-0">
					<section className="space-y-3">
						<h3 className="text-sm font-medium">Settings for all projects</h3>
						<ExportSettingsFields
							value={common}
							onChange={setCommon}
							disabled={busy || submitted.current.size > 0}
						/>
					</section>
					<div className="space-y-3">
						{rows.map((row) => {
							const job = jobs.find((j) => j.projectId === row.id);
							return (
								<section
									key={row.id}
									className="border rounded-lg p-3 space-y-3"
									aria-label={`Export ${row.info?.name ?? "project"}`}
								>
									<div className="flex flex-wrap items-center justify-between gap-2">
										<h3 className="text-sm font-medium">
											{row.info?.name ?? "Loading saved project…"}
										</h3>
										{row.info && (
											<span className="text-xs text-muted-foreground">
												Saved revision {row.info.sourceRevision}
											</span>
										)}
									</div>
									{row.info && (
										<>
											<label className="grid gap-1 text-sm">
												Scene
												<select
													aria-label={`Scene for ${row.info.name}`}
													className="bg-background border rounded p-2"
													disabled={busy || submitted.current.has(row.id)}
													value={row.sceneId ?? row.info.sceneId}
													onChange={(e) =>
														setRows((old) =>
															old.map((r) =>
																r.id === row.id
																	? { ...r, sceneId: e.target.value }
																	: r,
															),
														)
													}
												>
													{row.info.scenes.map((s) => (
														<option key={s.id} value={s.id}>
															{s.name}
															{s.isMain ? " · Main" : ""}
														</option>
													))}
												</select>
											</label>
											<label className="flex items-center gap-2 text-sm">
												<input
													type="checkbox"
													disabled={busy || submitted.current.has(row.id)}
													checked={!!row.override}
													onChange={(e) =>
														setRows((old) =>
															old.map((r) =>
																r.id === row.id
																	? {
																			...r,
																			override: e.target.checked
																				? structuredClone(common)
																				: undefined,
																		}
																	: r,
															),
														)
													}
												/>
												Custom settings for this project
											</label>
											{row.override && (
												<ExportSettingsFields
													value={row.override}
													disabled={busy || submitted.current.has(row.id)}
													onChange={(value) =>
														setRows((old) =>
															old.map((r) =>
																r.id === row.id ? { ...r, override: value } : r,
															),
														)
													}
												/>
											)}
											<ExportPlanSummary plan={row.info.plan} />
										</>
									)}
									{row.checking && (
										<p className="text-xs text-muted-foreground">
											Reading saved scene and checking encoder…
										</p>
									)}
									{row.error && (
										<p role="alert" className="text-xs text-destructive">
											{row.error}
										</p>
									)}
									{job && (
										<div className="space-y-2">
											<p className="text-sm capitalize">
												{job.status} · {job.message}
											</p>
											{job.status === "rendering" && (
												<Progress value={job.progress * 100} />
											)}
										</div>
									)}
								</section>
							);
						})}
					</div>
					{rows.some((r) => r.error) && !busy && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setRefreshToken((t) => t + 1)}
						>
							Refresh saved versions
						</Button>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
				</DialogBody>
				<DialogFooter className="shrink-0 flex-wrap sm:flex-wrap">
					{busy ? (
						<>
							<p className="mr-auto text-sm text-muted-foreground self-center">
								{submitting
									? "Preparing saved snapshots…"
									: "Exporting to your selected destination…"}
							</p>
							<Button
								variant="outline"
								disabled={submitting}
								onClick={() => void cancel()}
							>
								Cancel exports
							</Button>
						</>
					) : (
						<>
							<Button variant="outline" onClick={onClose}>
								{submitted.current.size ? "Done" : "Cancel"}
							</Button>
							<Button
								variant="outline"
								disabled={!ready || !remaining.length}
								onClick={() => void start("direct")}
							>
								<Download />
								Export directly
							</Button>
							<Button
								disabled={!ready || !remaining.length}
								onClick={() => void start("queue")}
							>
								<ListPlus />
								Add to Render Queue
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
/** Host destination suggestion; actual filenames are chosen by the native picker. */
function outputName(info: SavedExportInfo) {
	const scene = info.scenes.find((s) => s.id === info.sceneId);
	const stem =
		`${info.name}${info.scenes.length > 1 ? ` · ${scene?.name ?? "Scene"}` : ""}`
			.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
			.trim()
			.slice(0, 160) || "OpenCut export";
	return `${stem}.${info.options.format}`;
}
