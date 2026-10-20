"use client";
import { StandaloneWorker } from "@/batch/standalone-worker";
import { useEffect, useState } from "react";
import { executeBatch } from "@/batch/worker";
let started = false;
export default function BatchWorker() {
	const [owner, setOwner] = useState<string | null>(null);
	useEffect(
		() => setOwner(new URLSearchParams(location.search).get("owner")),
		[],
	);
	return owner ? <StandaloneWorker ownerId={owner} /> : <IframeWorker />;
}
function IframeWorker() {
	useEffect(() => {
		const ready = () => {
			if (!started)
				parent.postMessage({ type: "opencut-batch-ready" }, location.origin);
		};
		const handshake = setInterval(ready, 1000);
		const handle = (event: MessageEvent) => {
			if (
				event.origin === location.origin &&
				event.source === parent &&
				event.data?.type === "opencut-batch-probe"
			) {
				ready();
				return;
			}

			if (
				event.origin !== location.origin ||
				event.source !== parent ||
				event.data?.type !== "opencut-batch-start" ||
				started
			)
				return;
			started = true;
			clearInterval(handshake);
			void executeBatch(event.data).catch(async (error: unknown) => {
				const message =
					error instanceof Error
						? error.message
						: "Background worker initialization failed";
				for (const job of event.data.run.jobs)
					await fetch("/api/batch-edit", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-OpenCut-Batch-Token": event.data.token,
						},
						body: JSON.stringify({
							action: "update",
							id: event.data.run.id,
							projectId: job.projectId,
							event: "fail",
							message: message.slice(0, 4000),
						}),
					}).catch(() => {});
				parent.postMessage(
					{ type: "opencut-batch-finished", id: event.data.run.id },
					location.origin,
				);
			});
		};
		window.addEventListener("message", handle);
		ready();
		return () => {
			clearInterval(handshake);
			window.removeEventListener("message", handle);
		};
	}, []);
	return <p>Full Auto Edit batch worker</p>;
}
