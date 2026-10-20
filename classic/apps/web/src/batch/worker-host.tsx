"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
	onReady,
}: {
	task?: AutomationWorkerTask;
	onFinished: (id: string) => void;
	onReady?: () => void;
}) {
	const [saveFailure, setSaveFailure] = useState("");
	const [bootState, setBootState] = useState("loading");
	const [instanceId] = useState(() => crypto.randomUUID());
	const [retrying, setRetrying] = useState(false);
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
			if (task && event.data?.id === task.run.id) {
				if (
					event.data.type === "opencut-batch-save-blocked" &&
					typeof event.data.message === "string"
				) {
					setSaveFailure(event.data.message);
					setRetrying(false);
				}
				if (event.data.type === "opencut-batch-recovered") {
					setSaveFailure("");
					setRetrying(false);
				}
			}
			if (event.data?.type === "opencut-batch-ready") {
				setBootState("ready");
				onReady?.();
			}
			if (
				task &&
				event.data?.type === "opencut-batch-ready" &&
				!started &&
				!ended
			) {
				started = true;
				setBootState("started");
				clearTimeout(deadline);
				frame.current.contentWindow?.postMessage(
					{ type: "opencut-batch-start", ...task },
					location.origin,
				);
			}
			if (
				task &&
				event.data?.type === "opencut-batch-finished" &&
				event.data.id === task.run.id &&
				!ended
			) {
				ended = true;
				finish.current(task.run.id);
			}
		};
		const deadline = setTimeout(async () => {
			if (!task || started || ended) return;
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
		// Hidden documents may throttle timers. Readiness is also requested by
		// the visible host, rather than depending on the child's interval.
		const ping = setInterval(() => {
			if (!started && !ended)
				frame.current?.contentWindow?.postMessage(
					{ type: "opencut-batch-probe" },
					location.origin,
				);
		}, 1000);
		return () => {
			clearInterval(ping);
			clearTimeout(deadline);
			window.removeEventListener("message", receive);
		};
	}, [task, onReady]);
	return (
		<>
			{saveFailure && task && (
				<div
					role="alert"
					className="fixed bottom-4 right-4 z-50 max-w-lg rounded-lg border bg-background p-4 shadow-lg"
				>
					<p className="mb-3 text-sm">{saveFailure}</p>
					<Button
						disabled={retrying}
						onClick={() => {
							setRetrying(true);
							frame.current?.contentWindow?.postMessage(
								{ type: "opencut-batch-retry-save", id: task.run.id },
								location.origin,
							);
						}}
					>
						{retrying ? "Saving…" : "Retry saving"}
					</Button>
				</div>
			)}
			<iframe
				ref={frame}
				data-worker-state={bootState}
				onLoad={() => {
					setBootState((previous) =>
						previous === "started" ? previous : "document-loaded",
					);
					frame.current?.contentWindow?.postMessage(
						{ type: "opencut-batch-probe" },
						location.origin,
					);
				}}
				src={
					task
						? `/batch-worker?instance=${instanceId}&run=${encodeURIComponent(task.run.id)}`
						: `/batch-worker?instance=${instanceId}&warm=1`
				}
				loading="eager"
				title={
					task
						? "Full Auto Edit background worker"
						: "Preparing Full Auto Edit worker"
				}
				aria-hidden
				tabIndex={-1}
				style={{
					position: "fixed",
					right: 0,
					bottom: 0,
					opacity: 1,
					zIndex: 1,
					border: 0,
					width: 2,
					height: 2,
					pointerEvents: "none",
				}}
			/>
		</>
	);
}
