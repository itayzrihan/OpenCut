"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useEditor } from "@/editor/use-editor";
import { useInterfaceLanguage } from "@/i18n/provider";
import type { VideoElement } from "@/timeline/types";
import { TICKS_PER_SECOND } from "@/wasm";
import { canonical, fileUrl, scope, status } from "../client";
import { prepareReplacement, replacementDuration } from "../replace-clip";
import { REPLACE_MAX_REFERENCES, REPLACE_VIDEO_MODEL } from "../replace-model";
import { useDirectorReviewFocus } from "../review-focus";
import type { VideoGenerationModel } from "../seamless-models";
import type { DirectorReference, ReplaceMode } from "../types";

export function ReplaceDialog({
	open,
	onOpenChange,
	trackId,
	clip,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	trackId: string;
	clip: VideoElement;
}) {
	const editor = useEditor();
	const { t } = useInterfaceLanguage();
	const [mode, setMode] = useState<ReplaceMode>("refine");
	const [prompt, setPrompt] = useState("");
	const [files, setFiles] = useState<File[]>([]);
	const [chosen, setChosen] = useState<string[]>([]);
	const [images, setImages] = useState<DirectorReference[]>([]);
	const [model, setModel] = useState<VideoGenerationModel>();
	const [catalogError, setCatalogError] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const pending = useRef<AbortController | null>(null);
	const providerSeconds = replacementDuration({ model, ticks: clip.duration });
	const exactSeconds = Number((clip.duration / TICKS_PER_SECOND).toFixed(5));

	useEffect(() => {
		if (!open) return;
		const controller = new AbortController();
		const { signal } = controller;
		async function load() {
			const { projectId, accountId } = scope(editor);
			const response = await fetch(
				"/api/generative?" + new URLSearchParams({ projectId, models: "1" }),
				{ headers: { "X-OpenCut-Account": accountId }, signal },
			);
			const result: { models?: VideoGenerationModel[] } = await response.json();
			const wan = result.models?.find(
				(item) => item.id === REPLACE_VIDEO_MODEL,
			);
			if (
				!response.ok ||
				!wan ||
				!replacementDuration({ model: wan, ticks: 1 })
			)
				throw new Error("Wan 3.0 is unavailable for this replacement");
			if (!signal.aborted) {
				setModel(wan);
				setCatalogError("");
			}
		}
		void load().catch((failure) => {
			if (!signal.aborted) {
				setModel(undefined);
				setCatalogError(
					failure instanceof Error ? failure.message : String(failure),
				);
			}
		});
		async function loadImages() {
			const { projectId } = scope(editor);
			const state = await status({ projectId, signal });
			if (signal.aborted) return;
			setImages(
				state.jobs.flatMap((job) =>
					job.referenceImage &&
					job.status === "ready" &&
					job.output?.kind === "image"
						? [job.output]
						: [],
				),
			);
		}
		void loadImages().catch(() => undefined);
		return () => {
			controller.abort();
			pending.current?.abort();
		};
	}, [editor, open]);

	async function prepare(generateImage: boolean) {
		if (pending.current || !prompt.trim()) return;
		const controller = new AbortController();
		pending.current = controller;
		setError("");
		setBusy(true);
		try {
			const original = scope(editor);
			const sceneId = editor.scenes.getActiveSceneOrNull()?.id;
			if (!sceneId)
				throw new Error("Open the original scene to replace this clip");
			const job = await prepareReplacement({
				editor,
				target: { sceneId, trackId, elementId: clip.id },
				mode,
				prompt,
				files,
				chosenReferences: chosen,
				model,
				generateImage,
				signal: controller.signal,
			});
			canonical({
				editor,
				change: {
					type: "job",
					job: { id: job.id, digest: job.digest, status: "review" },
				},
			});
			useDirectorReviewFocus.getState().reveal({ ...original, jobId: job.id });
			useAssetsPanelStore.getState().setActiveTab("generative");
			if (!generateImage) {
				setPrompt("");
				setFiles([]);
				setChosen([]);
			}
			onOpenChange(false);
		} catch (failure) {
			if (!controller.signal.aborted)
				setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			pending.current = null;
			setBusy(false);
		}
	}
	const total = files.length + chosen.length;
	const projectId = editor.project.getActiveOrNull()?.metadata.id;
	const modeLabels = {
		refine: t("Keep style and characters"),
		full: t("Replace the entire scene"),
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90dvh] gap-5 overflow-y-auto p-6 sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("Replace clip")}</DialogTitle>
					<DialogDescription>
						{clip.name} · {exactSeconds}s
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						void prepare(false);
					}}
				>
					<fieldset disabled={busy} className="grid gap-2">
						<legend className="mb-2 text-sm font-medium">
							{t("Replacement mode")}
						</legend>
						{(["refine", "full"] as const).map((value) => (
							<label
								key={value}
								aria-label={modeLabels[value]}
								className="flex items-start gap-3 rounded-md border p-3 text-sm has-[:checked]:border-primary"
							>
								<input
									type="radio"
									name="replace-mode"
									aria-label={modeLabels[value]}
									className="mt-1"
									checked={mode === value}
									onChange={() => setMode(value)}
								/>
								<span className="grid gap-1">
									<strong>{modeLabels[value]}</strong>
									<span className="text-xs text-muted-foreground">
										{value === "refine"
											? t(
													"Use up to ten evenly spaced frames from this clip as references.",
												)
											: t(
													"Describe a new scene and optionally supply reference images.",
												)}
									</span>
								</span>
							</label>
						))}
					</fieldset>
					<label className="grid gap-2 text-sm">
						{t("What should happen in this clip?")}
						<Textarea
							dir="auto"
							required
							value={prompt}
							maxLength={12_000}
							disabled={busy}
							onChange={(event) => setPrompt(event.target.value)}
						/>
					</label>
					{mode === "full" && (
						<fieldset
							disabled={busy}
							className="grid gap-2 rounded-md border p-3 text-sm"
						>
							<label className="grid gap-2">
								{t("Upload reference images")}
								<input
									type="file"
									multiple
									accept="image/png,image/jpeg,image/webp"
									className="w-full rounded border p-2 text-xs"
									onChange={(event) => {
										const selected = Array.from(event.target.files ?? []);
										event.target.value = "";
										if (selected.length + total > REPLACE_MAX_REFERENCES) {
											setError("Choose up to ten reference images");
											return;
										}
										setError("");
										setFiles((current) => [...current, ...selected]);
									}}
								/>
							</label>
							{files.map((file, index) => (
								<div
									key={`${index}-${file.name}`}
									className="flex items-center justify-between gap-2 text-xs"
								>
									<span className="truncate">{file.name}</span>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										onClick={() =>
											setFiles((current) =>
												current.filter((_, i) => i !== index),
											)
										}
									>
										{t("Remove")}
									</Button>
								</div>
							))}
							{projectId && images.length > 0 && (
								<div className="grid max-h-48 gap-2 overflow-y-auto">
									{images.map((image) => (
										<label key={image.id} className="flex items-center gap-2">
											<input
												type="checkbox"
												checked={chosen.includes(image.id)}
												disabled={
													total >= REPLACE_MAX_REFERENCES &&
													!chosen.includes(image.id)
												}
												onChange={(event) =>
													setChosen(
														event.target.checked
															? [...chosen, image.id]
															: chosen.filter((id) => id !== image.id),
													)
												}
											/>
											<Image
												src={fileUrl({ projectId, id: image.id })}
												alt=""
												width={64}
												height={48}
												unoptimized
												className="h-12 w-16 rounded object-contain"
											/>
											<span>{image.name}</span>
										</label>
									))}
								</div>
							)}
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={!prompt.trim()}
								onClick={() => void prepare(true)}
							>
								{t("Prepare reference image")}
							</Button>
							<p className="text-xs text-muted-foreground">
								{t(
									"Reference images generated with Gemini use a separate OpenRouter approval. Reopen Replace to select the finished image.",
								)}
							</p>
						</fieldset>
					)}
					<p className="text-xs text-muted-foreground">
						{t(
							"The replacement keeps the exact clip length and original audio. Other clips stay in place.",
						)}
					</p>
					{providerSeconds !== undefined && (
						<p className="text-xs text-muted-foreground">
							Wan 3.0 · {providerSeconds}s · OpenRouter
						</p>
					)}
					{(error || catalogError) && (
						<p role="alert" className="text-sm text-destructive">
							{t(error || catalogError)}
						</p>
					)}
					<div className="flex flex-wrap justify-end gap-2 border-t pt-4">
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							{t("Close")}
						</Button>
						<Button
							type="submit"
							disabled={busy || !prompt.trim() || !providerSeconds}
						>
							{busy ? t("Preparing replacement…") : t("Prepare for review")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
