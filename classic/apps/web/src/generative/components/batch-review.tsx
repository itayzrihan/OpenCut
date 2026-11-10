/* eslint-disable @next/next/no-img-element -- Owned reference previews require the original authenticated same-origin bytes. */
import { useEffect, useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { validateChapterBatch, matchBatchJobs } from "../batch-validation";
import { Message } from "@/i18n/message";
import { Button } from "@/components/ui/button";
import { useInterfaceLanguage } from "@/i18n/provider";
import { api, fileUrl } from "../client";
import type { DirectorBatch, DirectorJob } from "../types";

function BatchReviewBody({
	projectId,
	batchId,
	jobs,
	validate,
}: {
	projectId: string;
	batchId: string;
	jobs: DirectorJob[];
	validate?: () => void;
}) {
	const { t } = useInterfaceLanguage();
	const editor = useEditor();
	const [account] = useState(() => window.__opencutAccountId);
	const [batch, setBatch] = useState<DirectorBatch | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [confirmed, setConfirmed] = useState(false);
	const pin = useRef<HTMLInputElement>(null);
	const { jobs: visibleJobs, complete } = matchBatchJobs({
		batch,
		jobs,
		projectId,
	});
	useEffect(() => {
		const controller = new AbortController();
		const load = () =>
			void api<{ batch: DirectorBatch }>({
				projectId,
				action: "batch-status",
				data: { id: batchId },
				signal: controller.signal,
			})
				.then((result) => {
					if (!controller.signal.aborted) setBatch(result.batch);
				})
				.catch((e) => {
					if (!controller.signal.aborted)
						setError(e instanceof Error ? e.message : String(e));
				});
		load();
		const timer = setInterval(load, 5000);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, [projectId, batchId]);
	async function submit(cancel = false) {
		if (
			!batch ||
			busy ||
			window.__opencutAccountId !== account ||
			(!cancel && !complete)
		)
			return;
		setBusy(true);
		setError("");
		try {
			if (!cancel) {
				validateChapterBatch({ editor, jobs: visibleJobs });
				validate?.();
			}
			const result = await api<{ batch: DirectorBatch }>({
				projectId,
				action: cancel ? "cancel-batch" : "approve-batch",
				data: {
					id: batch.id,
					digest: batch.digest,
					confirmed,
					pin: pin.current?.value,
				},
			});
			setBatch(result.batch);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (pin.current) pin.current.value = "";
			setBusy(false);
		}
	}
	if (window.__opencutAccountId !== account) return null;
	return (
		<section className="space-y-3 rounded-lg border p-3 text-sm">
			<strong>{t("Batch review")}</strong>
			<p className="text-xs text-muted-foreground">
				{t(
					"Review every request before approving. Up to three independent requests generate at once. Shared references guide continuity; exact matching is not guaranteed.",
				)}
			</p>
			{visibleJobs.map((job) => (
				<details key={job.id} className="rounded border p-2">
					<summary>
						{job.chapter?.title ??
							(job.kind === "storyboard"
								? t("Reference image")
								: "Seamless Connect")}{" "}
						· {job.duration ? `${job.duration}s · ` : ""}
						{job.status}
					</summary>
					{job.chapter?.sourceStartMs !== undefined &&
						job.chapter.sourceEndMs !== undefined && (
							<p className="text-xs">
								<Message
									text="Source {v0}s · Generated {v1}s"
									values={{
										v0: String(
											(job.chapter.sourceEndMs - job.chapter.sourceStartMs) /
												1000,
										),
										v1: String(job.duration),
									}}
								/>
								{job.chapter.timingEstimated
									? ` · ${t("Estimated timing")}`
									: ""}
							</p>
						)}
					<p className="break-words text-xs">
						{job.model} · {job.resolution} · {job.aspectRatio} · {job.videoMode}
					</p>
					<pre
						className="max-h-52 overflow-auto whitespace-pre-wrap text-xs"
						dir="auto"
					>
						{job.prompt}
					</pre>
					<p className="text-xs">
						{job.references.map((r) => r.name).join(", ")}
					</p>
					<div className="grid grid-cols-2 gap-2">
						{job.references
							.filter((r) => r.kind === "image")
							.map((r) => (
								<img
									key={r.id}
									src={fileUrl({ projectId, id: r.id })}
									alt={r.name}
									loading="lazy"
									className="max-h-40 w-full rounded object-contain"
								/>
							))}
					</div>
				</details>
			))}
			{batch && !complete && (
				<p role="status" className="text-xs">
					{t(
						"Waiting for every frozen request to load. Approval is disabled until all IDs and digests match.",
					)}
				</p>
			)}
			<p role="status" className="text-xs">
				{batch?.message}
			</p>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{batch && ["review", "paused"].includes(batch.status) && (
				<form
					className="space-y-2"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<label className="flex items-start gap-2 text-xs">
						<input
							type="checkbox"
							checked={confirmed}
							onChange={(event) => setConfirmed(event.target.checked)}
						/>
						{t(
							"I reviewed every frozen request and approve its provider charges. Exact cost is determined by the provider.",
						)}
					</label>
					<input
						ref={pin}
						type="password"
						autoComplete="off"
						inputMode="numeric"
						aria-label={t("Vault PIN")}
						placeholder={t("Vault PIN")}
						required
						className="w-full rounded border bg-background p-2"
					/>
					<Button disabled={busy || !confirmed || !complete} type="submit">
						{t("Approve batch with PIN")}
					</Button>
				</form>
			)}
			{batch && !["complete", "cancelled"].includes(batch.status) && (
				<Button
					variant="outline"
					disabled={busy}
					onClick={() => void submit(true)}
				>
					{t("Cancel unsent requests")}
				</Button>
			)}
			<p className="text-xs text-muted-foreground">
				{t(
					"Cancellation stops unsent requests. Accepted jobs can still finish and be charged. Interrupted submissions are never retried automatically.",
				)}
			</p>
		</section>
	);
}

export function BatchReview(props: {
	projectId: string;
	batchId: string;
	jobs: DirectorJob[];
	validate?: () => void;
}) {
	return (
		<BatchReviewBody
			key={`${window.__opencutAccountId}:${props.projectId}:${props.batchId}`}
			{...props}
		/>
	);
}
