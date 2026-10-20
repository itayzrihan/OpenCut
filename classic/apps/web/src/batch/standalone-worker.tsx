"use client";
import { useEffect, useState } from "react";
import { batchRequest } from "./client";
import { executeBatch } from "./worker";
import type { AutomationWorkerTask } from "./worker-host";
import type { BatchState } from "./types";

/** An independent browsing context owns model/decoder IO. The editor can reload
 * or navigate without destroying this executor or taking its write lease. */
export function StandaloneWorker({ ownerId }: { ownerId: string }) {
	const [message, setMessage] = useState("ממתין לעבודות העריכה…");
	useEffect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		let hasRun = false;
		let lastFailure: string | undefined;
		let idleSince = Date.now();
		const workerId = crypto.randomUUID();
		const tick = async () => {
			try {
				const task = await batchRequest<AutomationWorkerTask | null>({
					action: "recover",
					executor: "window",
					ownerId,
					workerId,
				});
				if (stopped) return;
				if (task) {
					hasRun = true;
					idleSince = Date.now();
					setMessage(`עורך כעת: ${task.run.jobs[0]?.name ?? "סצנה"}`);
					try {
						await executeBatch(task);
						const after = await batchRequest<BatchState>();
						const failed = after.runs
							.find((run) => run.id === task.run.id)
							?.jobs.find((job) => job.status === "failed");
						if (failed) lastFailure = failed.message;
					} catch (error) {
						const detail =
							error instanceof Error ? error.message : String(error);
						for (const job of task.run.jobs)
							await fetch("/api/batch-edit", {
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									"X-OpenCut-Batch-Token": task.token,
								},
								body: JSON.stringify({
									action: "update",
									id: task.run.id,
									projectId: job.projectId,
									event: "fail",
									message: detail.slice(0, 4000),
								}),
							}).catch(() => {});
						setMessage(detail);
						lastFailure = detail;
					}
				} else {
					const state = await batchRequest<BatchState>();
					const pending = state.runs.some(
						(run) =>
							run.executor === "window" &&
							run.jobs.some((job) => ["ready", "running"].includes(job.status)),
					);
					if (pending) idleSince = Date.now();
					else if (Date.now() - idleSince > (hasRun ? 5000 : 30000)) {
						setMessage(lastFailure ?? "העבודות נשמרו. אפשר לסגור את החלון.");
						if (!lastFailure) window.close();
						return;
					}
				}
			} catch (error) {
				setMessage(error instanceof Error ? error.message : String(error));
			}
			if (!stopped) timer = setTimeout(() => void tick(), 2000);
		};
		void tick();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [ownerId]);
	return (
		<main className="p-6 space-y-4" dir="rtl">
			<h1 className="text-xl font-semibold">עריכות ברקע</h1>
			<p role="status">{message}</p>
			<p className="text-sm text-muted-foreground">
				אפשר למזער חלון זה ולהמשיך לעבוד ב־OpenCut. התוצאות נשמרות כסצנות חדשות.
			</p>
		</main>
	);
}
