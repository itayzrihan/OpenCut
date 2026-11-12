"use client";
import {
	Message as UiMessage,
	LocalizedValue as UiValue,
} from "@/i18n/message";
import { useEffect, useState } from "react";
import { EditorCore } from "@/core";
import { renderQueueRequest } from "@/export/queue/client";
import { hasReleasedRenders } from "@/export/queue/runtime";
import { executeQueuedRender } from "@/export/queue/worker";
import type { RenderJob } from "@/export/queue/types";

let started = false;
const delay = () => new Promise((resolve) => setTimeout(resolve, 1500));
async function run({
	hosted,
	update,
}: {
	hosted: boolean;
	update: (message: string) => void;
}) {
	let idleSince = Date.now();
	for (;;) {
		const job = await renderQueueRequest<RenderJob | null>({
			action: "claim",
			attempt: crypto.randomUUID(),
		});
		if (job) {
			if (!hosted) {
				await executeQueuedRender(job, () => {});
				location.reload();
				return;
			}
			const editor = EditorCore.createRenderInstance();
			try {
				await executeQueuedRender(
					job,
					(message) =>
						update(`${job.snapshot.document.metadata.name} · ${message}`),
					undefined,
					editor,
				);
			} finally {
				editor.disposeRenderInstance();
			}
			idleSince = Date.now();
			continue;
		}
		const state = await renderQueueRequest();
		if (hasReleasedRenders(state)) idleSince = Date.now();
		if (Date.now() - idleSince > (hosted ? 5000 : 30000)) {
			if (hosted) update("Queue complete. You can close this render tab.");
			else window.opencutRenderWorker?.idle();
			return;
		}
		await delay();
	}
}
async function start(update: (message: string) => void) {
	const query = new URLSearchParams(location.search);
	if (query.get("hosted") !== "1") {
		// A regular browser visit must not impersonate the desktop worker.
		if (!window.opencutRenderWorker) return;
		for (;;) {
			try {
				return await run({ hosted: false, update });
			} catch (error) {
				console.error("Background queue connection:", String(error));
				await delay();
			}
		}
	}
	const response = await fetch("/api/accounts", { cache: "no-store" });
	const session = await response.json();
	const accountId = query.get("account");
	if (
		!response.ok ||
		!session.hostedLegitate ||
		!accountId ||
		session.account?.id !== accountId ||
		session.storageBusy
	)
		throw Error(
			"Sign in to the same POCUT account before resuming the render queue",
		);
	window.__opencutHostedLegitate = true;
	window.__opencutAccountId = accountId;
	await navigator.locks.request(
		`opencut-render-worker-${accountId}`,
		async () => {
			const confirmClose = (event: BeforeUnloadEvent) => event.preventDefault();
			window.addEventListener("beforeunload", confirmClose);
			try {
				await run({ hosted: true, update });
			} finally {
				window.removeEventListener("beforeunload", confirmClose);
			}
		},
	);
}
export default function RenderWorker() {
	const [message, setMessage] = useState(
		"Keep this render tab open while exports run.",
	);
	useEffect(() => {
		if (!started) {
			started = true;
			void start(setMessage).catch((error) => setMessage(String(error)));
		}
	}, []);
	return (
		<main className="mx-auto max-w-xl space-y-4 p-8">
			<h1 className="text-2xl font-semibold">
				<UiMessage text="POCUT background renderer" />
			</h1>
			<p role="status">
				<UiValue>{message}</UiValue>
			</p>
		</main>
	);
}

declare global {
	interface Window {
		opencutRenderWorker?: { idle: () => void };
	}
}
