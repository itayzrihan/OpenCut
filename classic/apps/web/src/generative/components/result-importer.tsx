"use client";
import { useEffect } from "react";
import { toast } from "@/i18n/toast";
import { useEditor, useEditorProject } from "@/editor/use-editor";
import { processMediaAssets } from "@/media/processing";
import { status } from "../client";
import { importDirectorResult } from "../result-import";
import { isHostedBrowserWorkspace } from "@/accounts/browser";
import { audioApi } from "@/audio-production/client";
import { saveAudioResult } from "@/audio-production/result-media";
import type { AudioStatus } from "@/audio-production/types";
import {
	assertLocalDriveWriteScope,
	captureLocalDriveWriteScope,
} from "@/services/local-drive/client";
/** Observer remains mounted when the user switches asset tabs. */
export function GenerativeResultImporter() {
	const editor = useEditor(),
		projectId = useEditorProject(
			(e) => e.project.getActiveOrNull()?.metadata.id,
		);
	useEffect(() => {
		if (!projectId) return;
		const accountId = window.__opencutAccountId;
		if (!accountId) return;
		let stopped = false;
		let polling = false;
		const controller = new AbortController();
		const audioSaved = new Set<string>();
		const current = () =>
			!stopped &&
			window.__opencutAccountId === accountId &&
			editor.project.getActiveOrNull()?.metadata.id === projectId;
		function report(error: unknown) {
			if (!controller.signal.aborted)
				console.warn("Could not save a generated project result:", error);
		}
		async function pollDirector() {
			try {
				const state = await status({
					projectId: projectId!,
					signal: controller.signal,
				});
				if (!current()) return;
				for (const job of state.jobs)
					await importDirectorResult({
						editor,
						projectId: projectId!,
						accountId: accountId!,
						job,
						signal: controller.signal,
						current,
						process: processMediaAssets,
						notify: (message) => toast.success(message),
						notifyWarning: (message) => toast.warning(message),
					}).catch(report);
			} catch (e) {
				report(e);
			}
		}
		async function pollAudio() {
			if (!isHostedBrowserWorkspace()) return;
			const scope = {
				...captureLocalDriveWriteScope({
					projectId: projectId!,
					accountId: accountId!,
				}),
				signal: controller.signal,
			};
			const { jobs } = await audioApi<AudioStatus>({
				projectId: projectId!,
				signal: controller.signal,
			});
			for (const job of jobs) {
				if (!current()) return;
				if (
					job.status !== "ready" ||
					!job.output ||
					audioSaved.has(job.output.id)
				)
					continue;
				try {
					const asset = await saveAudioResult({
						projectId: projectId!,
						job,
						scope,
						signal: controller.signal,
					});
					if (!current()) return;
					const existing = editor.media
						.getAssets()
						.find((item) => item.id === asset.id);
					if (
						existing &&
						(!existing.file || existing.missing) &&
						asset.file &&
						!editor.project.getSessionReadOnlyReason()
					) {
						assertLocalDriveWriteScope({ projectId: projectId!, scope });
						await editor.media.reopenBrowserSource({
							projectId: projectId!,
							id: asset.id,
							file: asset.file,
						});
					}
					audioSaved.add(job.output.id);
				} catch (error) {
					report(error);
				}
			}
		}
		async function poll() {
			if (polling || !current() || editor.project.getIsLoading()) return;
			polling = true;
			try {
				await Promise.all([pollDirector(), pollAudio().catch(report)]);
			} finally {
				polling = false;
			}
		}
		void poll();
		const timer = setInterval(() => void poll(), 5000);
		return () => {
			stopped = true;
			controller.abort();
			clearInterval(timer);
		};
	}, [editor, projectId]);
	return null;
}
