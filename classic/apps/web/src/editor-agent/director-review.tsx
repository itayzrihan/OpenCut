import { useEffect, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { useInterfaceLanguage } from "@/i18n/provider";
import { status } from "@/generative/client";
import { useDirectorReviewFocus } from "@/generative/review-focus";
import { DirectorJobReview } from "@/generative/components/generative-view";
import { validateChapterBatch } from "@/generative/components/chapter-plans";
import { BatchReview } from "@/generative/components/batch-review";
import type { DirectorJob } from "@/generative/types";

/** Provider review is a transport projection. Creative content stays in Rust. */
export function AgentDirectorReview({ projectId }: { projectId: string }) {
	const focus = useDirectorReviewFocus();
	const accountId = window.__opencutAccountId;
	if (
		focus.surface !== "agent" ||
		focus.projectId !== projectId ||
		focus.accountId !== accountId ||
		!focus.jobId
	)
		return null;
	return (
		<FocusedReview
			key={`${accountId}:${projectId}:${focus.jobId}:${focus.batchId ?? ""}`}
			projectId={projectId}
			jobId={focus.jobId}
			batchId={focus.batchId}
			accountId={accountId}
		/>
	);
}

function FocusedReview({
	projectId,
	jobId,
	batchId,
	accountId,
}: {
	projectId: string;
	jobId: string;
	batchId?: string;
	accountId: string;
}) {
	const { t } = useInterfaceLanguage();
	const editor = useEditor();
	const [jobs, setJobs] = useState<DirectorJob[]>([]);
	const [error, setError] = useState("");
	const [refresh, setRefresh] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		let pending = false;
		const load = async () => {
			if (pending) return;
			pending = true;
			try {
				if (
					window.__opencutAccountId !== accountId ||
					editor.project.getActiveOrNull()?.metadata.id !== projectId
				)
					return;
				const result = await status({ projectId, signal: controller.signal });
				if (
					!controller.signal.aborted &&
					window.__opencutAccountId === accountId &&
					editor.project.getActiveOrNull()?.metadata.id === projectId
				) {
					setJobs(result.jobs);
					setError("");
				}
			} catch (e) {
				if (!controller.signal.aborted)
					setError(e instanceof Error ? e.message : String(e));
			} finally {
				pending = false;
			}
		};
		void load();
		const interval = setInterval(() => void load(), 5000);
		return () => {
			controller.abort();
			clearInterval(interval);
		};
	}, [accountId, projectId, editor, refresh]);
	const job = jobs.find((item) => item.id === jobId);
	if (
		window.__opencutAccountId !== accountId ||
		editor.project.getActiveOrNull()?.metadata.id !== projectId
	)
		return null;
	return (
		<section className="mt-4 space-y-2" aria-label={t("Production approval")}>
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}
			{batchId ? (
				<BatchReview
					projectId={projectId}
					batchId={batchId}
					jobs={jobs.filter((item) => item.batchId === batchId)}
					validate={() =>
						validateChapterBatch({
							editor,
							jobs: jobs.filter((item) => item.batchId === batchId),
						})
					}
				/>
			) : job?.status === "review" ? (
				<DirectorJobReview
					job={job}
					onUpdated={() => setRefresh((value) => value + 1)}
				/>
			) : job ? (
				<p role="status" className="rounded border p-3 text-xs">
					{job.message}
				</p>
			) : (
				<p role="status" className="text-xs text-muted-foreground">
					{t("Loading production review…")}
				</p>
			)}
		</section>
	);
}
