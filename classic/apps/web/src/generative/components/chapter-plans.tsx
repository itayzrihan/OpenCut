/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- These values are validated by the canonical Rust capability schemas. */
import { useEffect, useRef, useState } from "react";
import { ChapterCollectionCard } from "./chapter-collection-card";
import { Message } from "@/i18n/message";
import { Button } from "@/components/ui/button";
import type { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { readProduction } from "@/production-studio/client";
import { useInterfaceLanguage } from "@/i18n/provider";
import { api, canonical, scope } from "../client";
import type {
	ChapterPlan,
	DirectorDocument,
	DirectorJob,
	DirectorBatch,
} from "../types";
import type { VideoGenerationModel } from "../seamless-models";
function validate({ editor, planId }: { editor: EditorCore; planId: string }) {
	return editor.command.invokeCanonicalControl({
		...scope(editor),
		capabilityId: "project.generative.chapters.validate",
		input: { planId },
	}) as { plan: ChapterPlan };
}
export function ChapterPlans({
	document,
	model,
	resolution,
	aspectRatio,
	refresh,
}: {
	document: DirectorDocument;
	model?: VideoGenerationModel;
	resolution: string;
	aspectRatio: string;
	refresh: () => void;
}) {
	const editor = useEditor();
	const { t } = useInterfaceLanguage();
	const [selection, setSelection] = useState("");
	const scripts = editor.project.getActiveOrNull()
		? (readProduction(editor).workspace.scripts ?? [])
		: [];
	const chosen = scripts.find((script) => script.id === selection);
	const segments = scripts.filter(
		(script) =>
			script.parentScriptId &&
			`segments:${script.parentScriptId}` === selection,
	);
	const scriptIds = chosen ? [chosen.id] : segments.map((script) => script.id);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const abort = useRef<AbortController | null>(null);
	useEffect(() => () => abort.current?.abort(), []);
	function build() {
		try {
			if (!model) throw new Error(t("Load the video model catalog first."));
			editor.command.invokeCanonicalControl({
				...scope(editor),
				capabilityId: "project.generative.chapters.build",
				input: {
					id: crypto.randomUUID(),
					title:
						chosen?.title ??
						scripts.find((script) => `segments:${script.id}` === selection)
							?.title ??
						t("Chapter collection"),
					scriptIds,
					model: model.id,
					resolution,
					aspectRatio,
					supportedDurations: model.supported_durations ?? [],
				},
			});
			refresh();
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}
	async function prepare(planId: string) {
		if (busy) return;
		const controller = new AbortController();
		abort.current = controller;
		setBusy(true);
		setError("");
		const original = scope(editor);
		const check = () => {
			controller.signal.throwIfAborted();
			const current = scope(editor);
			if (
				current.projectId !== original.projectId ||
				current.accountId !== original.accountId
			)
				throw new Error("Project or account changed");
			validate({ editor, planId });
		};
		try {
			const { plan } = validate({ editor, planId });
			const jobs: DirectorJob[] = [];
			for (const [index, chapter] of plan.chapters.entries()) {
				check();
				const { job } = await api<{ job: DirectorJob }>({
					projectId: original.projectId,
					action: "prepare",
					signal: controller.signal,
					data: {
						request: {
							projectId: original.projectId,
							kind: "video",
							model: plan.model,
							resolution: plan.resolution,
							aspectRatio: plan.aspectRatio,
							duration: chapter.duration,
							prompt: chapter.prompt,
							videoMode: plan.references.length ? "references" : "text",
							referenceIds: plan.references.map((r) => r.referenceId),
							chapter: {
								planId: plan.id,
								planVersion: plan.version,
								chapterId: chapter.id,
								index,
								total: plan.chapters.length,
								title: chapter.title,
								sourceStartMs: chapter.sourceStartMs,
								sourceEndMs: chapter.sourceEndMs,
								timingEstimated: chapter.timingEstimated,
							},
						},
					},
				});
				check();
				jobs.push(job);
				canonical({
					editor,
					change: {
						type: "job",
						job: { id: job.id, digest: job.digest, status: job.status },
					},
				});
			}
			const id = crypto.randomUUID().replaceAll("-", "");
			const { batch } = await api<{ batch: DirectorBatch }>({
				projectId: original.projectId,
				action: "prepare-batch",
				signal: controller.signal,
				data: {
					batch: {
						id,
						kind: "chapters",
						jobs: jobs.map((j) => ({ id: j.id, digest: j.digest })),
					},
				},
			});
			check();
			canonical({
				editor,
				change: {
					type: "chapterBatch",
					planId: plan.id,
					version: plan.version,
					batchId: batch.id,
					jobIds: jobs.map((j) => j.id),
				},
			});
			refresh();
		} catch (e) {
			if (!controller.signal.aborted)
				setError(e instanceof Error ? e.message : String(e));
		} finally {
			abort.current = null;
			setBusy(false);
		}
	}
	return (
		<section className="space-y-3 rounded-lg border p-3">
			<strong>{t("Generate chapters")}</strong>
			<p className="text-xs text-muted-foreground">
				{t(
					"Generate videos from the canonical script and approved references. Long rows split automatically to fit the live model. Review estimated dialogue timing before approval. Storyboards are optional.",
				)}
			</p>
			{scripts.length > 0 && (
				<label className="block text-sm">
					{t("Script for generation")}
					<select
						className="ml-2 rounded border bg-background p-1"
						value={selection}
						onChange={(event) => setSelection(event.target.value)}
					>
						<option value="">{t("Current Director script")}</option>
						{scripts.map((script) => (
							<option key={script.id} value={script.id}>
								{script.title}
							</option>
						))}
						{scripts
							.filter((script) =>
								scripts.some((segment) => segment.parentScriptId === script.id),
							)
							.map((script) => (
								<option
									key={`segments:${script.id}`}
									value={`segments:${script.id}`}
								>
									{t("All segments")} · {script.title}
								</option>
							))}
					</select>
				</label>
			)}
			<Button
				variant="outline"
				disabled={
					busy ||
					!model ||
					(!scriptIds.length &&
						scripts.length > 1 &&
						!document.productionHandoff)
				}
				onClick={build}
			>
				{t("Build chapter plan from script")}
			</Button>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{document.chapterPlans?.map((plan) => (
				<article key={plan.id} className="space-y-2 rounded border p-2 text-xs">
					<strong>
						{plan.title} · {plan.chapters.length}
					</strong>
					<p>
						<Message
							text="Total source {v0}s · Generated {v1}s"
							values={{
								v0: String(
									plan.chapters.reduce(
										(total, c) =>
											total + (c.sourceEndMs - c.sourceStartMs) / 1000,
										0,
									),
								),
								v1: String(
									plan.chapters.reduce((total, c) => total + c.duration, 0),
								),
							}}
						/>
					</p>
					<p className="text-muted-foreground">
						{t(
							"Generated duration may exceed source timing. Review pacing before approval; full generated clips are retained.",
						)}
					</p>
					<p>
						{plan.model} · {plan.resolution} · {plan.aspectRatio}
					</p>
					{plan.chapters.map((chapter) => (
						<details key={chapter.id}>
							<summary>
								{chapter.title} ·{" "}
								<Message
									text="Source {v0}s · Generated {v1}s"
									values={{
										v0: String(
											(chapter.sourceEndMs - chapter.sourceStartMs) / 1000,
										),
										v1: String(chapter.duration),
									}}
								/>{" "}
								· {(chapter.sourceStartMs / 1000).toFixed(1)}–
								{(chapter.sourceEndMs / 1000).toFixed(1)}s{" "}
								{chapter.timingEstimated ? t("Estimated timing") : ""}
							</summary>
							<p dir="auto" className="whitespace-pre-wrap">
								{chapter.sourceText}
							</p>
							<p className="whitespace-pre-wrap">
								{chapter.latinTransliteration}
							</p>
							<p dir="auto">{chapter.visualDescription}</p>
						</details>
					))}
					{!plan.batchId && (
						<Button disabled={busy} onClick={() => void prepare(plan.id)}>
							{t("Prepare chapter batch for approval")}
						</Button>
					)}
					{plan.batchId && (
						<p>{t("Prepared requests appear in Batch review below.")}</p>
					)}
				</article>
			))}
			{busy && (
				<Button variant="ghost" onClick={() => abort.current?.abort()}>
					{t("Cancel preparation")}
				</Button>
			)}
		</section>
	);
}
export function ChapterCollections({
	document,
}: {
	document: DirectorDocument;
}) {
	const editor = useEditor();
	const { t } = useInterfaceLanguage();
	const [error, setError] = useState("");
	const plans =
		document.chapterPlans?.filter(
			(p) =>
				p.jobIds.length === p.chapters.length &&
				p.jobIds.every((id) =>
					document.jobs.some(
						(j) => j.id === id && j.status === "ready" && j.mediaId,
					),
				),
		) ?? [];
	function insert(planId: string) {
		try {
			const sceneId = editor.scenes.getActiveSceneOrNull()?.id;
			if (!sceneId) throw new Error("Open a scene first");
			const output = editor.command.invokeCanonicalControl({
				...scope(editor),
				capabilityId: "project.generative.chapters.collection",
				input: { planId, startTime: editor.playback.getCurrentTime() },
			}) as { clips: Record<string, unknown>[] };
			const inserted = editor.command.invokeCanonicalControl({
				...scope(editor),
				capabilityId: "timeline.classic.elements.insert",
				input: { sceneId, clips: output.clips },
			}) as { elements: { trackId: string; elementId: string }[] };
			setError("");
			return inserted.elements;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return null;
		}
	}
	return plans.length ? (
		<section className="space-y-2 rounded-lg border p-3">
			<strong>{t("Chapter collections")}</strong>
			<p className="text-xs text-muted-foreground">
				{t(
					"Each chapter is also in Media. Insert a collection as separate editable clips with every cut preserved.",
				)}
			</p>
			{plans.map((plan) => (
				<ChapterCollectionCard
					key={plan.id}
					plan={plan}
					document={document}
					insert={() => insert(plan.id)}
				/>
			))}
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}
		</section>
	) : null;
}
export { validateChapterBatch } from "../batch-validation";

/** Reactive projection only: the saved collection lives in the canonical document. */
export function AssetChapterCollections() {
	const editor = useEditor();
	const [document, setDocument] = useState<DirectorDocument | null>(null);
	useEffect(() => {
		let stopped = false;
		const read = () => {
			try {
				const next = canonical({ editor }).document;
				if (!stopped) setDocument(next);
			} catch {
				if (!stopped) setDocument(null);
			}
		};
		queueMicrotask(read);
		const timer = setInterval(read, 2000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [editor]);
	return document ? <ChapterCollections document={document} /> : null;
}
