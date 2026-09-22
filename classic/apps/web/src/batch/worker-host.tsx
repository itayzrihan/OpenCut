"use client";
import { useEffect, useRef } from "react";
import type { BatchRun, BatchSource } from "./types";

export interface AutomationWorkerTask {
	run: BatchRun;
	token: string;
	files: BatchSource[];
}

/** Mounted in the application root, never under a route or visible editor. */
export function AutomationWorkerHost({
	task,
	onFinished,
}: {
	task: AutomationWorkerTask;
	onFinished: (id: string) => void;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const finish = useRef(onFinished);
	useEffect(() => {
		finish.current = onFinished;
	}, [onFinished]);
	useEffect(() => {
		let started = false;
		let ended = false;
		const receive = (event: MessageEvent) => {
			if (
				event.origin !== location.origin ||
				event.source !== frame.current?.contentWindow
			)
				return;
			if (event.data?.type === "opencut-batch-ready" && !started && !ended) {
				started = true;
				clearTimeout(deadline);
				frame.current.contentWindow?.postMessage(
					{ type: "opencut-batch-start", ...task },
					location.origin,
				);
			}
			if (
				event.data?.type === "opencut-batch-finished" &&
				event.data.id === task.run.id &&
				!ended
			) {
				ended = true;
				finish.current(task.run.id);
			}
		};
		const deadline = setTimeout(async () => {
			if (started || ended) return;
			ended = true;
			for (const job of task.run.jobs) {
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
						message:
							"Background worker could not start. Your source project was preserved.",
					}),
				}).catch(() => {});
			}
			finish.current(task.run.id);
		}, 90_000);
		window.addEventListener("message", receive);
		return () => {
			clearTimeout(deadline);
			window.removeEventListener("message", receive);
		};
	}, [task]);
	return (
		<iframe
			ref={frame}
			src="/batch-worker"
			title="Full Auto Edit background worker"
			aria-hidden
			tabIndex={-1}
			style={{
				position: "fixed",
				left: -10000,
				width: 640,
				height: 360,
				pointerEvents: "none",
			}}
		/>
	);
}
