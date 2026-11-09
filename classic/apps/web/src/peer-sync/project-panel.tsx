"use client";
import { ACCOUNT_WORKSPACE_HREF } from "@/accounts/workspace-route";
import { LocalizedValue as UiValue } from "@/i18n/message";
import {
	LocalizedElement as UiLocalized,
	Message as UiMessage,
} from "@/i18n/message";
import { useEffect, useRef, useState } from "react";
import type { EditorCore } from "@/core";
import { invokePeerMedia, type EditorPullJob } from "./editor-client";
import type { PeerStatus } from "./types";

function waitForProgress(signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const finish = () => {
			signal.removeEventListener("abort", abort);
			resolve();
		};
		const timer = setTimeout(finish, 1000);
		const abort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			reject(
				new Error("Download paused. Partial files are retained for resume."),
			);
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}
function bytes(value: number) {
	if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
	return `${(value / 1024 ** 2).toFixed(1)} MB`;
}
export function ProjectMediaPullPanel({
	editor,
	projectId,
}: {
	editor: EditorCore;
	projectId: string;
}) {
	const [status, setStatus] = useState<PeerStatus | null>(null),
		[deviceId, setDeviceId] = useState("");
	const [jobs, setJobs] = useState<EditorPullJob[]>([]),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	const active = useRef<{
		controller: AbortController;
		operationId: string;
	} | null>(null);
	useEffect(() => {
		const controller = new AbortController(),
			accountId = window.__opencutAccountId;
		const refresh = async () => {
			try {
				const response = await fetch("/api/accounts/peers", {
					cache: "no-store",
					signal: controller.signal,
				});
				const value = await response.json();
				if (!response.ok) throw new Error(value.error);
				if (
					window.__opencutAccountId !== accountId ||
					editor.project.getActiveOrNull()?.metadata.id !== projectId
				)
					return;
				setStatus(value);
				setDeviceId((previous) => previous || value.devices[0]?.id || "");
				const transfers = await invokePeerMedia({
					editor,
					capabilityId: "media.transfer.list",
					signal: controller.signal,
				});
				if (!controller.signal.aborted) setJobs(transfers.jobs);
			} catch (e) {
				if (!controller.signal.aborted)
					setError(e instanceof Error ? e.message : String(e));
			}
		};
		void refresh();
		const timer = setInterval(() => {
			if (!active.current) void refresh();
		}, 10_000);
		return () => {
			clearInterval(timer);
			controller.abort();
			active.current?.controller.abort();
			active.current = null;
		};
	}, [editor, projectId]);
	function update(job: EditorPullJob) {
		setJobs((previous) =>
			[
				job,
				...previous.filter((item) => item.operationId !== job.operationId),
			].slice(0, 100),
		);
	}
	async function pullAll(onlyJob?: EditorPullJob) {
		if (active.current) return;
		const controller = new AbortController(),
			accountId = window.__opencutAccountId;
		active.current = { controller, operationId: "" };
		setBusy(true);
		setError("");
		const scope = () => {
			controller.signal.throwIfAborted();
			if (
				window.__opencutAccountId !== accountId ||
				editor.project.getActiveOrNull()?.metadata.id !== projectId
			)
				throw new Error(
					"Account or project changed. Downloaded files stay with the original project.",
				);
		};
		try {
			const missing = onlyJob
				? editor.media
						.getAssets()
						.filter((asset) => asset.id === onlyJob.mediaId && asset.missing)
				: editor.media
						.getAssets()
						.filter((asset) => asset.missing && !asset.unifiedAngles);
			for (const asset of missing) {
				scope();
				let job =
					onlyJob ??
					jobs.find(
						(item) =>
							item.mediaId === asset.id &&
							item.deviceId === deviceId &&
							item.expectedBindingRevision === (asset.bindingRevision ?? 0),
					);
				const operationId = job?.operationId ?? crypto.randomUUID();
				active.current!.operationId = operationId;
				if (job?.status !== "ready") {
					if (!(job?.deviceId || deviceId))
						throw new Error("Choose an online source computer");
					const started = await invokePeerMedia({
						editor,
						capabilityId: "media.transfer.start",
						signal: controller.signal,
						input: {
							mediaId: asset.id,
							deviceId: job?.deviceId || deviceId,
							operationId,
							expectedBindingRevision: asset.bindingRevision ?? 0,
							resume: !!job,
						},
					});
					if (!started.job) throw new Error("No transfer job was returned");
					job = started.job;
					update(job);
				}
				while (job.status === "running") {
					await waitForProgress(controller.signal);
					scope();
					const progress = await invokePeerMedia({
						editor,
						capabilityId: "media.transfer.status",
						input: { operationId },
						signal: controller.signal,
					});
					if (!progress.job)
						throw new Error("Transfer progress is unavailable");
					job = progress.job;
					update(job);
				}
				scope();
				if (job.status !== "ready")
					throw new Error(job.error || "Original transfer did not finish");
				await invokePeerMedia({
					editor,
					capabilityId: "media.transfer.commit",
					input: { operationId },
					signal: controller.signal,
				});
				scope();
			}
		} catch (e) {
			if (active.current?.controller === controller)
				setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (active.current?.controller === controller) {
				active.current = null;
				setBusy(false);
			}
		}
	}
	async function cancel() {
		const operationId = active.current?.operationId;
		active.current?.controller.abort();
		if (!operationId) return;
		try {
			const result = await invokePeerMedia({
				editor,
				capabilityId: "media.transfer.cancel",
				input: { operationId },
				signal: AbortSignal.timeout(15_000),
			});
			if (result.job) update(result.job);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}
	const missing = editor.media
		.getAssets()
		.filter((asset) => asset.missing && !asset.unifiedAngles);
	return (
		<UiLocalized<"section">
			element={"section"}
			messageProps={["aria-label"]}
			className="space-y-2 rounded border p-3"
			aria-label="Pull missing project files"
		>
			<h3 className="font-medium">
				<UiMessage text={"Get missing files from your other computer"} />
			</h3>
			<p>
				<UiMessage
					text={
						"Keep editing here while the originals download. Both computers need sharing enabled under the same Legitate account."
					}
				/>
			</p>
			{!status?.configured || !status.enabled || !status.linked ? (
				<p>
					<a className="underline" href={ACCOUNT_WORKSPACE_HREF}>
						<UiMessage text={"Set up device transfers in account settings"} />
					</a>
				</p>
			) : (
				<>
					<div className="flex flex-wrap items-center gap-2">
						<UiLocalized<"select">
							element={"select"}
							messageProps={["aria-label"]}
							aria-label="Source computer"
							className="rounded border bg-background p-1"
							value={deviceId}
							disabled={busy}
							onChange={(event) => setDeviceId(event.target.value)}
						>
							<UiLocalized<"option">
								element={"option"}
								messageProps={["children"]}
								value=""
							>
								{"Choose a computer"}
							</UiLocalized>
							{status.devices.map((peer) => (
								<option key={peer.id} value={peer.id}>
									{peer.name}
								</option>
							))}
						</UiLocalized>
						<button
							disabled={
								busy || !deviceId || !missing.length || !status.connected
							}
							onClick={() => void pullAll()}
						>
							<UiMessage text={"Pull"} /> {missing.length}{" "}
							<UiMessage text={"missing file(s)"} />
						</button>
						{busy && (
							<button className="underline" onClick={() => void cancel()}>
								<UiMessage text={"Pause download"} />
							</button>
						)}
					</div>
					{!status.devices.length && (
						<p>
							<UiMessage
								text={
									"No other computer is online. Open POCUT there and keep it signed in."
								}
							/>
						</p>
					)}
				</>
			)}
			{jobs
				.filter((job) => missing.some((asset) => asset.id === job.mediaId))
				.slice(0, 12)
				.map((job) => (
					<div key={job.operationId} className="space-y-1">
						<div>
							{editor.media
								.getAssets()
								.find((asset) => asset.id === job.mediaId)?.name || job.mediaId}
							:{" "}
							{job.phase === "ready" ? (
								<UiMessage text={"Downloaded and verified"} />
							) : job.status === "running" ? (
								job.phase.replaceAll("-", " ")
							) : (
								job.status
							)}
						</div>
						<progress
							aria-label={`Download progress for ${job.mediaId}`}
							className="w-full"
							max={Math.max(1, job.totalBytes)}
							value={job.receivedBytes}
						/>
						<div>
							{bytes(job.receivedBytes)} / {bytes(job.totalBytes)}
						</div>
						{job.error && <p className="text-red-500">{job.error}</p>}
						{!busy && job.status !== "running" && (
							<button className="underline" onClick={() => void pullAll(job)}>
								{job.status === "ready" ? (
									<UiMessage text={"Link downloaded original"} />
								) : (
									<UiMessage text={"Resume this download"} />
								)}
							</button>
						)}
					</div>
				))}
			{error && (
				<p role="alert" className="text-red-500">
					<UiValue>{error}</UiValue>
				</p>
			)}
		</UiLocalized>
	);
}
