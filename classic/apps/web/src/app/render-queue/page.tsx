"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { accountAssetUrl } from "@/accounts/browser";
import { renderQueueRequest } from "@/export/queue/client";
import type { ExportOptions } from "@/export";
import type {
	RenderJobView,
	RenderJob,
	RenderQueueView,
} from "@/export/queue/types";
let running = false;
export default function RenderQueue() {
	const [state, setState] = useState<RenderQueueView>({
		revision: 0,
		jobs: [],
	});
	const [error, setError] = useState<string | null>(null);
	const [activity, setActivity] = useState("Waiting for jobs");
	useEffect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		let poll: ReturnType<typeof setInterval>;
		const refresh = async () => {
			try {
				const s = await renderQueueRequest();
				if (!stopped) {
					setState(s);
					setError(null);
				}
			} catch (e) {
				if (!stopped) setError(String(e));
			}
		};
		poll = setInterval(() => void refresh(), 2000);
		void refresh();
		const tick = async () => {
			if (stopped) return;
			try {
				if (!running) {
					const job = await renderQueueRequest<RenderJob | null>({
						action: "claim",
						attempt: crypto.randomUUID(),
					});
					if (job) {
						running = true;
						setActivity(`Rendering ${job.snapshot.document.metadata.name}`);
						await refresh();
						const preventClose = (e: BeforeUnloadEvent) => {
							e.preventDefault();
							e.returnValue = "";
						};
						window.addEventListener("beforeunload", preventClose);
						try {
							const { executeQueuedRender } =
								await import("@/export/queue/worker");
							await executeQueuedRender(job, setActivity);
						} finally {
							window.removeEventListener("beforeunload", preventClose);
							running = false;
						}
						// Reclaim all decoder/GPU resources between jobs. Durable canonical
						// state, not this page, selects the next snapshot after reload.
						location.reload();
						return;
					}
				}
			} catch (e) {
				if (!stopped) setError(String(e));
			}
			if (!stopped) timer = setTimeout(() => void tick(), 2000);
		};
		void tick();
		return () => {
			stopped = true;
			clearTimeout(timer);
			clearInterval(poll);
		};
	}, []);
	async function change(
		id: string,
		projectId: string,
		action: "cancel" | "retry",
	) {
		try {
			setState(
				await renderQueueRequest({
					action,
					id,
					projectId,
					expectedRevision: state.revision,
				}),
			);
			setError(null);
		} catch (e) {
			setError(String(e));
		}
	}
	return (
		<main className="mx-auto max-w-5xl p-6 space-y-5">
			<div>
				<h1 className="text-2xl font-semibold">OpenCut Render Queue</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					Keep this window open or minimized. You can continue editing in
					OpenCut. Each job renders its saved scene snapshot.
				</p>
			</div>
			<p role="status" className="text-sm">
				{activity}
			</p>
			{error && (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			)}
			{!state.jobs.length && (
				<div className="border rounded-lg p-8 text-muted-foreground">
					Your queue is empty. Choose Export → Add to Render Queue in any
					project.
				</div>
			)}
			<div className="space-y-3">
				{state.jobs.map((job) => (
					<article
						key={job.id}
						data-render-job={job.id}
						className="border rounded-lg p-4 space-y-3"
					>
						<div className="flex items-start justify-between gap-4">
							<div className="min-w-0">
								<h2 className="font-semibold truncate">{job.projectName}</h2>
								<p className="text-sm truncate">{job.sceneName}</p>
								<p className="text-xs text-muted-foreground">
									Saved {new Date(job.createdAtMs).toLocaleString()} · revision{" "}
									{job.sourceRevision}
								</p>
							</div>
							<span className="capitalize text-sm font-medium">
								{job.status}
							</span>
						</div>
						<p className="text-sm text-muted-foreground">
							{job.options.format.toUpperCase()} ·{" "}
							{job.options.preferences.resolution === "source"
								? "Source resolution"
								: "Project resolution"}{" "}
							·{" "}
							{job.options.preferences.encoding === "compact"
								? "HEVC"
								: "H.264"}{" "}
							· {job.options.quality.replaceAll("_", " ")} ·{" "}
							{job.options.fps.numerator / job.options.fps.denominator} fps ·
							Audio {job.options.includeAudio ? "on" : "off"}
						</p>
						{job.status === "rendering" && (
							<Progress
								value={job.progress * 100}
								aria-label={`Render progress ${job.projectName}`}
							/>
						)}
						<p className="text-xs text-muted-foreground">
							{job.message}
							{job.status === "rendering"
								? ` · ${Math.round(job.progress * 100)}%`
								: ""}
						</p>
						<div className="flex gap-2">
							{["queued", "rendering"].includes(job.status) && (
								<Button
									size="sm"
									variant="outline"
									disabled={job.cancelRequested}
									onClick={() => void change(job.id, job.projectId, "cancel")}
								>
									{job.cancelRequested ? "Cancelling…" : "Cancel"}
								</Button>
							)}
							{["failed", "cancelled"].includes(job.status) && (
								<Button
									size="sm"
									variant="outline"
									onClick={() => void change(job.id, job.projectId, "retry")}
								>
									Retry saved snapshot
								</Button>
							)}
							{job.status === "completed" && (
								<a
									className="text-sm text-primary underline"
									href={accountAssetUrl(
										`/api/render-queue/file?job=${encodeURIComponent(job.id)}`,
									)}
									download
								>
									Download {job.options.format.toUpperCase()}
								</a>
							)}
						</div>
						{job.status === "queued" && (
							<JobSettings
								job={job}
								revision={state.revision}
								onSave={setState}
								onError={setError}
							/>
						)}
						<details className="text-xs text-muted-foreground">
							<summary>Snapshot details</summary>
							<p className="mt-2 break-all">{job.snapshotHash}</p>
						</details>
					</article>
				))}
			</div>
		</main>
	);
}

function JobSettings({
	job,
	revision,
	onSave,
	onError,
}: {
	job: RenderJobView;
	revision: number;
	onSave: (state: RenderQueueView) => void;
	onError: (error: string) => void;
}) {
	const [draft, setDraft] = useState(job.options);
	const [saving, setSaving] = useState(false);
	const selectClass = "bg-background border rounded p-1.5 text-xs";
	return (
		<details className="text-sm">
			<summary>Edit export settings</summary>
			<form
				className="mt-3 flex flex-wrap items-end gap-3"
				onSubmit={async (e) => {
					e.preventDefault();
					setSaving(true);
					try {
						onSave(
							await renderQueueRequest({
								action: "configure",
								id: job.id,
								projectId: job.projectId,
								expectedRevision: revision,
								options: draft,
							}),
						);
					} catch (error) {
						onError(String(error));
					} finally {
						setSaving(false);
					}
				}}
			>
				<label className="grid gap-1">
					Format
					<select
						className={selectClass}
						value={draft.format}
						onChange={(e) =>
							setDraft({ ...draft, format: e.target.value as "mp4" | "webm" })
						}
					>
						<option value="mp4">MP4</option>
						<option value="webm">WebM</option>
					</select>
				</label>
				<label className="grid gap-1">
					Resolution
					<select
						className={selectClass}
						value={draft.preferences.resolution}
						onChange={(e) =>
							setDraft({
								...draft,
								preferences: {
									...draft.preferences,
									resolution: e.target.value as "source" | "project",
								},
							})
						}
					>
						<option value="source">Source</option>
						<option value="project">Project</option>
					</select>
				</label>
				<label className="grid gap-1">
					Encoding
					<select
						className={selectClass}
						value={draft.preferences.encoding}
						onChange={(e) =>
							setDraft({
								...draft,
								preferences: {
									...draft.preferences,
									encoding: e.target.value as "compact" | "compatible",
								},
							})
						}
					>
						<option value="compact">HEVC</option>
						<option value="compatible">H.264</option>
					</select>
				</label>
				<label className="grid gap-1">
					Quality
					<select
						className={selectClass}
						value={draft.quality}
						onChange={(e) =>
							setDraft({
								...draft,
								quality: e.target.value as Required<ExportOptions>["quality"],
							})
						}
					>
						{["low", "medium", "high", "very_high"].map((q) => (
							<option key={q} value={q}>
								{q.replaceAll("_", " ")}
							</option>
						))}
					</select>
				</label>
				<label className="flex items-center gap-2">
					<input
						type="checkbox"
						checked={draft.includeAudio}
						onChange={(e) =>
							setDraft({ ...draft, includeAudio: e.target.checked })
						}
					/>
					Audio
				</label>
				<Button size="sm" disabled={saving} type="submit">
					{saving ? "Saving…" : "Save settings"}
				</Button>
			</form>
		</details>
	);
}
