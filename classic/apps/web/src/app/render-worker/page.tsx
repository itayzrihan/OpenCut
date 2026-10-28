"use client";
import { useEffect } from "react";
import { renderQueueRequest } from "@/export/queue/client";
import { executeQueuedRender } from "@/export/queue/worker";
import type { RenderJob, RenderQueueView } from "@/export/queue/types";
let started = false;
const delay = () => new Promise((resolve) => setTimeout(resolve, 2000));
async function run() {
	let idleSince = Date.now();
	for (;;) {
		try {
			const job = await renderQueueRequest<RenderJob | null>({
				action: "claim",
				attempt: crypto.randomUUID(),
			});
			if (job) {
				await executeQueuedRender(job, () => {});
				location.reload();
				return;
			}
			const state = await renderQueueRequest<RenderQueueView>();
			if (
				state.jobs.some(
					(j) =>
						j.delivery !== "direct" &&
						["queued", "rendering"].includes(j.status),
				)
			)
				idleSince = Date.now();
			if (Date.now() - idleSince > 30000) {
				(
					window as Window & { opencutRenderWorker?: { idle: () => void } }
				).opencutRenderWorker?.idle();
				return;
			}
		} catch (error) {
			console.error("Background queue connection:", String(error));
		}
		await delay();
	}
}
export default function RenderWorker() {
	useEffect(() => {
		if (!started) {
			started = true;
			void run();
		}
	}, []);
	return <main>OpenCut background renderer</main>;
}
