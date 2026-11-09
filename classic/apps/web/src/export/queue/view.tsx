"use client";
import { LocalizedValue as UiValue } from "@/i18n/message";
import {
	Message as UiMessage,
	LocalizedElement as UiLocalized,
} from "@/i18n/message";
import { ElectronBackButton } from "@/components/electron-back-button";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { changeQueuedRender } from "@/export/queue/actions";
import { accountAssetUrl } from "@/accounts/browser";
import { renderQueueRequest } from "@/export/queue/client";
import type { ExportOptions } from "@/export";
import type {
	RenderJobView,
	RenderJob,
	RenderQueueView,
} from "@/export/queue/types";
export default function RenderQueue() {
	const [state, setState] = useState<RenderQueueView>({
		revision: 0,
		jobs: [],
	});
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let stopped = false;
		const refresh = async () => {
			try {
				const next = await renderQueueRequest();
				if (!stopped) setState(next);
			} catch (e) {
				if (!stopped) setError(String(e));
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 2000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, []);
	async function change(
		id: string,
		projectId: string,
		action: "cancel" | "retry",
	) {
		try {
			setState(await changeQueuedRender({ action, id, projectId, state }));
			setError(null);
		} catch (e) {
			setError(String(e));
		}
	}
	return (
		<main className="mx-auto max-w-5xl p-6 space-y-5">
			<div>
				<header className="flex flex-wrap items-center gap-3">
					<ElectronBackButton />
					<h1 className="text-2xl font-semibold">
						<UiMessage text={"POCUT Render Queue"} />
					</h1>
				</header>
				<p className="mt-2 text-sm text-muted-foreground">
					<UiMessage
						text={
							"You can close this view and continue editing. The background renderer processes each job’s saved scene snapshot."
						}
					/>
				</p>
			</div>
			<p role="status" className="text-sm">
				{state.worker?.message ?? (
					<UiMessage text={"Background render queue"} />
				)}
			</p>
			{error && (
				<p role="alert" className="text-destructive text-sm">
					<UiValue>{error}</UiValue>
				</p>
			)}
			{!state.jobs.length && (
				<div className="border rounded-lg p-8 text-muted-foreground">
					<UiMessage
						text={
							"Your queue is empty. Choose Export → Add to Render Queue in any project."
						}
					/>
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
									<UiMessage text={"Saved"} />{" "}
									{new Date(job.createdAtMs).toLocaleString()}{" "}
									<UiMessage text={"· revision"} /> {job.sourceRevision}
								</p>
							</div>
							<span className="capitalize text-sm font-medium">
								{job.status}
							</span>
						</div>
						<p className="text-sm text-muted-foreground">
							{job.options.format.toUpperCase()} ·{" "}
							{job.options.preferences.resolution === "source" ? (
								<UiMessage text={"Source resolution"} />
							) : (
								<UiMessage text={"Project resolution"} />
							)}{" "}
							·{" "}
							{job.options.format === "webm" ? (
								"VP9"
							) : job.options.preferences.encoding === "compact" ? (
								<UiMessage text={"HEVC"} />
							) : (
								"H.264"
							)}{" "}
							· {job.options.quality.replaceAll("_", " ")} ·{" "}
							{job.options.fps.numerator / job.options.fps.denominator}{" "}
							<UiMessage text={"fps · Audio"} />{" "}
							{job.options.includeAudio ? (
								<UiMessage text={"on"} />
							) : (
								<UiMessage text={"off"} />
							)}
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
									{job.cancelRequested ? (
										<UiMessage text={"Cancelling…"} />
									) : (
										<UiMessage text={"Cancel"} />
									)}
								</Button>
							)}
							{["failed", "cancelled"].includes(job.status) &&
								job.delivery !== "direct" && (
									<Button
										size="sm"
										variant="outline"
										onClick={() => void change(job.id, job.projectId, "retry")}
									>
										<UiMessage text={"Retry saved snapshot"} />
									</Button>
								)}
							{job.status === "completed" && job.outputId && (
								<a
									className="text-sm text-primary underline"
									href={accountAssetUrl(
										`/api/render-queue/file?job=${encodeURIComponent(job.id)}`,
									)}
									download
								>
									<UiMessage text={"Download"} />{" "}
									{job.options.format.toUpperCase()}
								</a>
							)}
						</div>
						{job.status === "queued" && job.delivery !== "direct" && (
							<JobSettings
								job={job}
								revision={state.revision}
								onSave={setState}
								onError={setError}
							/>
						)}
						<details className="text-xs text-muted-foreground">
							<summary>
								<UiMessage text={"Snapshot details"} />
							</summary>
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
			<summary>
				<UiMessage text={"Edit export settings"} />
			</summary>
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
					<UiMessage text={"Format"} />
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
					<UiMessage text={"Resolution"} />
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
						<UiLocalized<"option">
							element={"option"}
							messageProps={["children"]}
							value="source"
						>
							{"Source"}
						</UiLocalized>
						<UiLocalized<"option">
							element={"option"}
							messageProps={["children"]}
							value="project"
						>
							{"Project"}
						</UiLocalized>
					</select>
				</label>
				<label className="grid gap-1">
					<UiMessage text={"Encoding"} />
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
						<UiLocalized<"option">
							element={"option"}
							messageProps={["children"]}
							value="compact"
						>
							{"HEVC"}
						</UiLocalized>
						<option value="compatible">H.264</option>
					</select>
				</label>
				<label className="grid gap-1">
					<UiMessage text={"Quality"} />
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
					<UiMessage text={"Audio"} />
				</label>
				<Button size="sm" disabled={saving} type="submit">
					{saving ? (
						<UiMessage text={"Saving…"} />
					) : (
						<UiMessage text={"Save settings"} />
					)}
				</Button>
			</form>
		</details>
	);
}
