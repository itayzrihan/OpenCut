"use client";
import { Message as UiMessage } from "@/i18n/message";
import { useEffect, useState } from "react";
import { batchRequest } from "./client";
import { executeBatch } from "./worker";
import type { AutomationWorkerTask } from "./worker-host";
import type { BatchState } from "./types";

/** An independent browsing context owns model/decoder IO. The editor can reload
 * or navigate without destroying this executor or taking its write lease. */
export function StandaloneWorker({ ownerId }: { ownerId: string }) {
	const [message, setMessage] = useState("Waiting for editing jobs…");
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
					setMessage(`Editing: ${task.run.jobs[0]?.name ?? "scene"}`);
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
						setMessage(
							lastFailure ?? "Edits saved. You can close this window.",
						);
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
		<main className="p-6 space-y-4">
			<h1 className="text-xl font-semibold">
				<UiMessage text={"Background Edits"} />
			</h1>
			<p role="status">{message}</p>
			<p className="text-sm text-muted-foreground">
				<UiMessage
					text={
						"You can minimize this window and keep working in POCUT. Results are saved as new scenes."
					}
				/>
			</p>
		</main>
	);
}
