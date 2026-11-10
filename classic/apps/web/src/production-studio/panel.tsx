"use client";
/* eslint-disable @next/next/no-img-element -- Account-owned reference URLs must remain authenticated and unproxied. */

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { EditorCore } from "@/core";
import { connectedProviderFetch } from "@/ai/local-connection";
import {
	prepareProductionReferenceBatch,
	cancelProductionReferenceBatch,
} from "@/ai/production-image";
import { animateDirectorHandoff } from "@/editor-agent/production-handoff";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
	useEditor,
	useEditorHistory,
	useEditorMedia,
	useEditorProject,
} from "@/editor/use-editor";
import { useInterfaceLanguage } from "@/i18n/provider";
import { toast } from "@/i18n/toast";
import { fileUrl } from "@/generative/client";
import {
	attachProductionReference,
	editProduction,
	formatProductionTime,
	readProduction,
} from "./client";
import {
	generateProductionReference,
	productionGenerationId,
} from "./generation";
import { requestVideoAnalysis } from "./analysis";
import type {
	GenerateProductionReference,
	ReferenceSlot,
	ScriptContent,
	ScriptRow,
} from "./types";

type Change = (change: Record<string, unknown>) => boolean;
const card = "space-y-3 rounded-lg border border-border bg-background/60 p-3";
const selectClass =
	"h-8 max-w-full rounded border border-border bg-background px-2 text-xs";

/** Only unsaved form drafts and human review selections live in React. Every
 * script, image version, approval and report is read from the runtime. */
export function ProductionStudioPanel({
	className,
	onGenerateReference,
	onAnalyzeVideo,
}: {
	className?: string;
	onGenerateReference?: GenerateProductionReference;
	onAnalyzeVideo?: (input: { mediaId: string; sourceName: string }) => void;
}) {
	const editor = useEditor();
	const { t } = useInterfaceLanguage();
	const projectId = useEditorProject(
		(e) => e.project.getActiveOrNull()?.metadata.id,
	);
	useEditorHistory((e) => e.command.getCanonicalRevision());
	const accountId =
		typeof window === "undefined"
			? "local"
			: (window.__opencutAccountId ?? "local");
	if (!projectId)
		return (
			<p className="p-3 text-sm">
				{t("Open a project to use the production workspace")}
			</p>
		);
	return (
		<Workspace
			key={`${accountId}:${projectId}`}
			{...{
				editor,
				projectId,
				accountId,
				className,
				onGenerateReference,
				onAnalyzeVideo,
			}}
		/>
	);
}

function Workspace({
	editor,
	projectId,
	accountId,
	className,
	onGenerateReference,
	onAnalyzeVideo,
}: {
	editor: EditorCore;
	projectId: string;
	accountId: string;
	className?: string;
	onGenerateReference?: GenerateProductionReference;
	onAnalyzeVideo?: (input: { mediaId: string; sourceName: string }) => void;
}) {
	const { t } = useInterfaceLanguage();
	const { workspace } = readProduction(editor);
	const media = useEditorMedia((e) =>
		e.media.getAssets().filter((asset) => asset.type === "video"),
	);
	const [tab, setTab] = useState<"script" | "references" | "analysis">(
		"script",
	);
	const [text, setText] = useState("");
	const [language, setLanguage] = useState("und");
	const [duration, setDuration] = useState("4");
	const [replace, setReplace] = useState(false);
	const [slotLabel, setSlotLabel] = useState("");
	const [videoId, setVideoId] = useState("");
	const [handoffRequest, setHandoffRequest] = useState("");
	const [recommendStoryboard, setRecommendStoryboard] = useState(false);
	const [selected, setSelected] = useState<string[]>([]);
	const [review, setReview] = useState<ReferenceSlot[] | null>(null);
	const [provider, setProvider] = useState<"codex" | "openrouter">(
		"openrouter",
	);
	const [model, setModel] = useState("");
	const [models, setModels] = useState<
		Array<{ id: string; name: string; inputModalities: string[] }>
	>([]);
	const [nativeAvailable, setNativeAvailable] = useState(false);
	const [catalogError, setCatalogError] = useState("");
	const [reviewSettings, setReviewSettings] = useState<{
		provider: "codex" | "openrouter";
		model?: string;
	}>({ provider: "openrouter" });
	const [progress, setProgress] = useState("");
	const [busy, setBusy] = useState(false);
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	useEffect(() => {
		if (tab !== "references") return;
		const abort = new AbortController();
		const active = () =>
			!abort.signal.aborted &&
			(window.__opencutAccountId ?? "local") === accountId &&
			editor.project.getActiveOrNull()?.metadata.id === projectId;
		void (async () => {
			try {
				const response = await fetch(
					`/api/generative?${new URLSearchParams({ projectId, imageModels: "1" })}`,
					{
						credentials: "same-origin",
						headers: { "X-OpenCut-Account": accountId },
						signal: abort.signal,
					},
				);
				if (!response.ok)
					throw new Error(t("Image models could not be loaded"));
				const result = z
					.object({
						models: z.array(
							z.object({
								id: z.string(),
								name: z.string(),
								inputModalities: z.array(z.string()),
							}),
						),
					})
					.parse(await response.json());
				if (active()) {
					setModels(result.models);
					setCatalogError("");
					setModel((prior) =>
						result.models.some((item) => item.id === prior)
							? prior
							: (result.models[0]?.id ?? ""),
					);
				}
			} catch (error) {
				if (active())
					setCatalogError(
						error instanceof Error
							? error.message
							: "Image models could not be loaded",
					);
			}
		})();
		void (async () => {
			try {
				const response = await connectedProviderFetch({
					path: "/api/editor-agent/connection",
					providerOverride: "codex",
					init: { signal: abort.signal },
				});
				const value = z
					.object({
						sharing: z.boolean().optional(),
						imageGenerationSupported: z.boolean().optional(),
					})
					.parse(await response.json());
				if (active())
					setNativeAvailable(
						response.ok &&
							value.sharing === true &&
							value.imageGenerationSupported === true,
					);
			} catch {
				if (active()) setNativeAvailable(false);
			}
		})();
		return () => abort.abort();
	}, [tab, projectId, accountId, editor, t]);
	const checkScope = () => {
		if (
			editor.project.getActiveOrNull()?.metadata.id !== projectId ||
			(window.__opencutAccountId ?? "local") !== accountId
		)
			throw new Error(t("The production account or project changed"));
	};
	const change: Change = (input) => {
		try {
			checkScope();
			editProduction({ editor, accountId, projectId, change: input });
			return true;
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "The production change could not be saved",
			);
			return false;
		}
	};
	function sendToDirector() {
		try {
			checkScope();
			const handoffId = crypto.randomUUID();
			const referenceIds = [
				...new Set(
					workspace.referenceSlots
						.filter(
							(slot) =>
								slot.selectedVersion !== null &&
								slot.approvedVersion === slot.selectedVersion,
						)
						.flatMap((slot) =>
							slot.versions
								.filter((version) => version.version === slot.selectedVersion)
								.map((version) => version.referenceId),
						),
				),
			];
			editor.command.invokeCanonicalControl({
				projectId,
				accountId,
				capabilityId: "project.production.handoff",
				input: {
					handoffId,
					request: handoffRequest,
					storyboardRecommended: recommendStoryboard,
				},
			});
			animateDirectorHandoff({ projectId, referenceIds, handoffId });
			toast.success("Production workspace sent to Director");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "The production handoff could not be saved",
			);
		}
	}
	async function upload({ slot, file }: { slot: ReferenceSlot; file: File }) {
		const abort = new AbortController();
		controller.current = abort;
		setBusy(true);
		try {
			checkScope();
			await attachProductionReference({
				editor,
				slot,
				blob: file,
				name: file.name,
				source: "uploaded",
				caption: file.name,
				signal: abort.signal,
			});
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Reference upload failed",
			);
		} finally {
			controller.current = null;
			setBusy(false);
		}
	}
	async function generateReviewed() {
		if (!review?.length || review.length > 10 || busy) return;
		const batch = review;
		const abort = new AbortController();
		controller.current = abort;
		setBusy(true);
		let completed = 0;
		let batchReceipt: { id: string; accountId: string } | undefined;
		try {
			const requests = [];
			for (const slot of batch) {
				checkScope();
				abort.signal.throwIfAborted();
				const current = readProduction(editor).workspace.referenceSlots.find(
					(item) => item.id === slot.id,
				);
				if (current?.slotVersion !== slot.slotVersion)
					throw new Error(
						t(
							"A reviewed reference changed. Review the remaining images again.",
						),
					);
				const reference = slot.versions.find(
					(version) => version.version === slot.selectedVersion,
				);
				const referenceIds = reference ? [reference.referenceId] : [];
				const operationId = await productionGenerationId({
					accountId,
					projectId,
					slotId: slot.id,
					slotVersion: slot.slotVersion,
					prompt: slot.purpose,
					referenceIds,
					...reviewSettings,
				});
				requests.push({
					slotId: slot.id,
					prompt: slot.purpose,
					referenceIds,
					operationId,
					signal: abort.signal,
					...reviewSettings,
				});
			}
			checkScope();
			abort.signal.throwIfAborted();
			if (!onGenerateReference)
				batchReceipt = await prepareProductionReferenceBatch({
					projectId,
					items: requests,
					signal: abort.signal,
					...reviewSettings,
				});
			for (const [index, slot] of batch.entries()) {
				checkScope();
				abort.signal.throwIfAborted();
				if (
					readProduction(editor).workspace.referenceSlots.find(
						(item) => item.id === slot.id,
					)?.slotVersion !== slot.slotVersion
				)
					throw new Error(
						t(
							"A reviewed reference changed. Review the remaining images again.",
						),
					);
				setProgress(`${completed + 1} / ${batch.length} · ${slot.label}`);
				const request = requests[index]!;
				const result = await (onGenerateReference
					? onGenerateReference(request)
					: generateProductionReference({ editor, ...request }));
				checkScope();
				abort.signal.throwIfAborted();
				await attachProductionReference({
					editor,
					slot,
					blob: result.blob,
					name: `${slot.label}.png`,
					source: "generated",
					caption: slot.purpose,
					signal: abort.signal,
				});
				completed += 1;
			}
			setSelected([]);
			setReview(null);
			toast.success("Reference versions are ready for review");
		} catch (error) {
			let cancellationError = "";
			if (abort.signal.aborted && batchReceipt) {
				try {
					await cancelProductionReferenceBatch({ projectId, ...batchReceipt });
				} catch (failure) {
					cancellationError =
						failure instanceof Error
							? failure.message
							: "Queued image requests could not be cancelled";
				}
			}
			setReview(null);
			setSelected(batch.slice(completed).map((slot) => slot.id));
			toast.error(
				cancellationError ||
					(error instanceof Error
						? error.message
						: "Reference generation failed"),
			);
		} finally {
			controller.current = null;
			setBusy(false);
			setProgress("");
		}
	}
	return (
		<section
			data-production-board="true"
			className={`space-y-3 p-3 text-sm ${className ?? ""}`}
			aria-label={t("Production workspace")}
		>
			<header>
				<h3 className="font-semibold">{t("Production workspace")}</h3>
				<p className="text-xs text-muted-foreground">
					{t(
						"A shared script, reference board and evidence reports for you and your agent.",
					)}
				</p>
			</header>
			<details className={card}>
				<summary className="cursor-pointer font-medium">
					{t("Send to Director")}
				</summary>
				<p className="text-xs text-muted-foreground">
					{t(
						"Send the complete current script, pronunciation, timing and approved images. Existing image versions stay intact; no generation starts.",
					)}
				</p>
				<label className="block">
					{t("Production request")}
					<Textarea
						dir="auto"
						value={handoffRequest}
						maxLength={6000}
						onChange={(event) => setHandoffRequest(event.target.value)}
					/>
				</label>
				<label className="flex gap-2">
					<input
						type="checkbox"
						checked={recommendStoryboard}
						onChange={(event) => setRecommendStoryboard(event.target.checked)}
					/>
					{t("Recommend a storyboard first (optional)")}
				</label>
				<Button
					size="sm"
					disabled={busy || !workspace.scriptRows.length}
					onClick={sendToDirector}
				>
					{t("Send to Director")}
				</Button>
			</details>
			<nav
				className="flex flex-wrap gap-1"
				aria-label={t("Production sections")}
			>
				{(["script", "references", "analysis"] as const).map((value) => (
					<Button
						key={value}
						size="sm"
						variant={tab === value ? "secondary" : "ghost"}
						aria-pressed={tab === value}
						onClick={() => setTab(value)}
					>
						{t(
							value === "script"
								? "Timed script"
								: value === "references"
									? "Reference board"
									: "Video analysis",
						)}
					</Button>
				))}
			</nav>
			{busy && (
				<div role="status" className={card}>
					<p>{progress || t("Uploading reference…")}</p>
					<Button size="sm" onClick={() => controller.current?.abort()}>
						{t("Cancel")}
					</Button>
				</div>
			)}
			{tab === "script" && (
				<>
					<details className={card} open={workspace.scriptRows.length === 0}>
						<summary className="cursor-pointer font-medium">
							{t("Paste a script or SRT")}
						</summary>
						<label className="block space-y-1">
							<span>{t("Original script")}</span>
							<Textarea
								dir="auto"
								value={text}
								maxLength={100000}
								rows={5}
								onChange={(event) => setText(event.target.value)}
							/>
						</label>
						<div className="grid grid-cols-2 gap-2">
							<label>
								{t("Source language")}
								<Input
									value={language}
									maxLength={32}
									placeholder="he / en / ar"
									onChange={(event) => setLanguage(event.target.value)}
								/>
							</label>
							<label>
								{t("Seconds per untimed line")}
								<Input
									type="number"
									min={0.25}
									max={30}
									step={0.25}
									value={duration}
									onChange={(event) => setDuration(event.target.value)}
								/>
							</label>
						</div>
						<p className="text-xs text-muted-foreground">
							{t(
								"SRT keeps its timestamps. Plain lines receive estimated timing; the original language is preserved.",
							)}
						</p>
						<label className="flex gap-2">
							<input
								type="checkbox"
								checked={replace}
								onChange={(event) => setReplace(event.target.checked)}
							/>
							{t("Replace the current script (available in Undo)")}
						</label>
						<Button
							size="sm"
							disabled={!text.trim()}
							onClick={() => {
								if (
									change({
										type: "importScript",
										rowIdPrefix: crypto.randomUUID(),
										text,
										sourceLanguage: language,
										defaultDurationMs: Math.round(Number(duration) * 1000),
										replace,
									})
								)
									setText("");
							}}
						>
							{t("Import script")}
						</Button>
					</details>
					{workspace.scriptRows.map((row, index) => (
						<ScriptRowCard
							key={row.id}
							row={row}
							index={index}
							change={change}
						/>
					))}
				</>
			)}
			{tab === "references" && (
				<>
					<div className={card}>
						<label className="block">
							{t("Image provider")}
							<select
								className={`${selectClass} w-full`}
								value={provider}
								disabled={busy}
								onChange={(event) =>
									setProvider(
										event.target.value === "codex" ? "codex" : "openrouter",
									)
								}
							>
								<option value="openrouter">OpenRouter</option>
								<option value="codex" disabled={!nativeAvailable}>
									Codex ·{" "}
									{t(
										nativeAvailable ? "Connected" : "Connect in Agent settings",
									)}
								</option>
							</select>
						</label>
						{provider === "openrouter" && (
							<label className="block">
								{t("Image model")}
								<select
									className={`${selectClass} w-full`}
									value={model}
									disabled={busy || !models.length}
									onChange={(event) => setModel(event.target.value)}
								>
									{models.map((item) => (
										<option key={item.id} value={item.id}>
											{item.name}
										</option>
									))}
								</select>
							</label>
						)}
						{catalogError && provider === "openrouter" && (
							<p role="status" className="text-xs text-amber-500">
								{catalogError}
							</p>
						)}
					</div>
					<div className="flex gap-2">
						<Input
							aria-label={t("Reference slot name")}
							placeholder={t("Reference slot name")}
							value={slotLabel}
							maxLength={160}
							onChange={(event) => setSlotLabel(event.target.value)}
						/>
						<Button
							size="sm"
							disabled={!slotLabel.trim() || busy}
							onClick={() => {
								if (
									change({
										type: "createReferenceSlot",
										slotId: crypto.randomUUID(),
										label: slotLabel,
										purpose: "",
									})
								)
									setSlotLabel("");
							}}
						>
							{t("Add slot")}
						</Button>
					</div>
					<p className="text-xs text-muted-foreground">
						{t(
							"Replace one image without changing the others. Approval belongs to the selected version only.",
						)}
					</p>
					{workspace.referenceSlots.map((slot) => (
						<ReferenceCard
							key={slot.id}
							{...{ slot, projectId, change, busy }}
							selected={selected.includes(slot.id)}
							onSelect={(checked) =>
								setSelected((prior) =>
									checked
										? [...prior, slot.id].slice(0, 10)
										: prior.filter((id) => id !== slot.id),
								)
							}
							onUpload={(file) => {
								void upload({ slot, file });
							}}
						/>
					))}
					<Button
						size="sm"
						disabled={
							busy ||
							!selected.length ||
							(provider === "codex"
								? !nativeAvailable
								: !models.some((item) => item.id === model))
						}
						onClick={() => {
							setReviewSettings({
								provider,
								...(provider === "openrouter" ? { model } : {}),
							});
							setReview(
								workspace.referenceSlots
									.filter((slot) => selected.includes(slot.id))
									.map((slot) => structuredClone(slot)),
							);
						}}
					>
						{t("Review image generation")} ({selected.length}/10)
					</Button>
					{review && (
						<div
							className={`${card} border-primary/50`}
							role="region"
							aria-label={t("Review image generation")}
						>
							<p className="font-semibold">
								{t("Review these exact image requests")}
							</p>
							<p className="text-xs">
								{reviewSettings.provider === "codex"
									? "Codex"
									: `OpenRouter · ${reviewSettings.model}`}{" "}
								·{" "}
								{t(
									"Completed versions remain if you cancel; image approval is a separate step. OpenRouter requires one PIN approval for this frozen batch.",
								)}
							</p>
							{review.map((slot) => (
								<div key={slot.id} className="border-t pt-2">
									<b>{slot.label}</b>
									<p dir="auto" className="whitespace-pre-wrap break-words">
										{slot.purpose ||
											t("Add a generation brief to this slot first")}
									</p>
									{slot.selectedVersion !== null && (
										<p className="text-xs text-muted-foreground">
											{t("Includes the selected image as a reference")} · v
											{slot.selectedVersion}
										</p>
									)}
								</div>
							))}
							<div className="flex flex-wrap gap-2">
								<Button
									size="sm"
									disabled={busy || review.some((slot) => !slot.purpose.trim())}
									onClick={() => {
										void generateReviewed();
									}}
								>
									{t("Generate reviewed references")} ({review.length})
								</Button>
								<Button
									size="sm"
									variant="ghost"
									disabled={busy}
									onClick={() => setReview(null)}
								>
									{t("Back")}
								</Button>
							</div>
						</div>
					)}
				</>
			)}
			{tab === "analysis" && (
				<>
					<div className={card}>
						<label className="block">
							{t("Source video")}
							<select
								className={`${selectClass} mt-1 w-full`}
								value={videoId}
								onChange={(event) => setVideoId(event.target.value)}
							>
								<option value="">{t("Choose a project video")}</option>
								{media.map((asset) => (
									<option key={asset.id} value={asset.id}>
										{asset.name}
									</option>
								))}
							</select>
						</label>
						<p className="text-xs text-muted-foreground">
							{t(
								"Prepare an agent request to inspect real frames and timed audio evidence, then assess the hook, humor, call to action and visuals. You review the request before sending.",
							)}
						</p>
						<Button
							size="sm"
							disabled={!media.some((asset) => asset.id === videoId)}
							onClick={() => {
								const asset = media.find((item) => item.id === videoId);
								if (asset) {
									checkScope();
									const input = { mediaId: asset.id, sourceName: asset.name };
									if (onAnalyzeVideo) onAnalyzeVideo(input);
									else requestVideoAnalysis({ editor, ...input });
								}
							}}
						>
							{t("Prepare video analysis")}
						</Button>
					</div>
					{workspace.analyses.map((report) => (
						<article key={report.id} className={card}>
							<h4 className="font-semibold" dir="auto">
								{report.title}
							</h4>
							<p className="text-xs text-muted-foreground">
								{t("Reviewed intervals")}:{" "}
								{report.reviewedRanges
									.map(
										(range) =>
											`${formatProductionTime(range.startMs)}–${formatProductionTime(range.endMs)}`,
									)
									.join(", ")}
							</p>
							{report.observations.map((item, index) => (
								<div key={index} className="space-y-1 border-t pt-2">
									<p className="text-xs">
										{t(item.aspect)} · {formatProductionTime(item.startMs)}–
										{formatProductionTime(item.endMs)} · {t(item.confidence)}
									</p>
									<p dir="auto">
										<b>{t("Observed")}: </b>
										{item.observation}
									</p>
									<p dir="auto">
										<b>{t("Interpretation")}: </b>
										{item.interpretation}
									</p>
									<details className="text-xs">
										<summary>{t("Evidence")}</summary>
										{item.evidenceIds.map((id) => (
											<p key={id} className="break-all">
												{id}
											</p>
										))}
									</details>
								</div>
							))}
							<p dir="auto" className="text-xs text-muted-foreground">
								<b>{t("Limits of this review")}: </b>
								{report.limitations}
							</p>
						</article>
					))}
				</>
			)}
		</section>
	);
}

function ScriptRowCard({
	row,
	index,
	change,
}: {
	row: ScriptRow;
	index: number;
	change: Change;
}) {
	const { t } = useInterfaceLanguage();
	const current = row.versions[row.versions.length - 1]!;
	const [draft, setDraft] = useState<{
		content: ScriptContent;
		version: number;
	} | null>(null);
	const [history, setHistory] = useState<number | null>(null);
	const shown =
		row.versions.find((version) => version.version === history) ?? current;
	const stale = draft && draft.version !== row.currentVersion;
	const content = ({
		startMs,
		endMs,
		sourceLanguage,
		sourceText,
		latinTransliteration,
		speaker,
		visualDescription,
		timingEstimated,
	}: ScriptContent): ScriptContent => ({
		startMs,
		endMs,
		sourceLanguage,
		sourceText,
		latinTransliteration,
		speaker,
		visualDescription,
		timingEstimated,
	});
	const update = (value: Partial<ScriptContent>) =>
		setDraft((prior) =>
			prior ? { ...prior, content: { ...prior.content, ...value } } : prior,
		);
	return (
		<article className={card}>
			<header className="flex flex-wrap items-center justify-between gap-2">
				<b>
					{index + 1}. {formatProductionTime(shown.startMs)} →{" "}
					{formatProductionTime(shown.endMs)}
				</b>
				<select
					aria-label={t("Script version history")}
					className={selectClass}
					value={history ?? row.currentVersion}
					onChange={(event) => {
						setHistory(Number(event.target.value));
						setDraft(null);
					}}
				>
					{row.versions.map((version) => (
						<option key={version.version} value={version.version}>
							v{version.version} · {version.createdAt.slice(0, 19)}
							{version.version === row.currentVersion
								? ` · ${t("Current")}`
								: ""}
						</option>
					))}
				</select>
			</header>
			{draft ? (
				<div className="space-y-2">
					{stale && (
						<p role="alert" className="text-amber-500">
							{t(
								"This row changed elsewhere. Your draft is preserved; reopen the current version before saving.",
							)}
						</p>
					)}
					<div className="grid grid-cols-2 gap-2">
						<label>
							{t("Start (seconds)")}
							<Input
								type="number"
								min={0}
								step={0.001}
								value={draft.content.startMs / 1000}
								onChange={(event) =>
									update({
										startMs: Math.round(Number(event.target.value) * 1000),
										timingEstimated: false,
									})
								}
							/>
						</label>
						<label>
							{t("End (seconds)")}
							<Input
								type="number"
								min={0}
								step={0.001}
								value={draft.content.endMs / 1000}
								onChange={(event) =>
									update({
										endMs: Math.round(Number(event.target.value) * 1000),
										timingEstimated: false,
									})
								}
							/>
						</label>
						<label>
							{t("Source language")}
							<Input
								value={draft.content.sourceLanguage}
								onChange={(event) =>
									update({ sourceLanguage: event.target.value })
								}
							/>
						</label>
						<label>
							{t("Speaker")}
							<Input
								dir="auto"
								value={draft.content.speaker}
								onChange={(event) => update({ speaker: event.target.value })}
							/>
						</label>
					</div>
					<label className="block">
						{t("Original dialogue")}
						<Textarea
							dir="auto"
							value={draft.content.sourceText}
							onChange={(event) => update({ sourceText: event.target.value })}
						/>
					</label>
					<label className="block">
						{t("Latin transliteration")}
						<Textarea
							dir="ltr"
							value={draft.content.latinTransliteration}
							onChange={(event) =>
								update({ latinTransliteration: event.target.value })
							}
						/>
					</label>
					<label className="block">
						{t("Planned visual")}
						<Textarea
							dir="auto"
							value={draft.content.visualDescription}
							onChange={(event) =>
								update({ visualDescription: event.target.value })
							}
						/>
					</label>
					<Button
						size="sm"
						disabled={!!stale}
						onClick={() => {
							if (
								change({
									type: "editScriptRow",
									rowId: row.id,
									expectedRowVersion: draft.version,
									content: draft.content,
									changeNote: "Edited in production workspace",
								})
							) {
								setDraft(null);
								setHistory(null);
							}
						}}
					>
						{t("Save row version")}
					</Button>{" "}
					<Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
						{t("Cancel")}
					</Button>
				</div>
			) : (
				<>
					<p dir="auto" className="whitespace-pre-wrap">
						{shown.sourceText}
					</p>
					{shown.latinTransliteration && (
						<p dir="ltr" className="whitespace-pre-wrap text-muted-foreground">
							{shown.latinTransliteration}
						</p>
					)}
					{shown.visualDescription && (
						<p dir="auto" className="text-xs">
							<b>{t("Planned visual")}: </b>
							{shown.visualDescription}
						</p>
					)}
					<p className="text-xs text-muted-foreground">
						{shown.sourceLanguage}
						{shown.speaker && ` · ${shown.speaker}`} ·{" "}
						{t(shown.timingEstimated ? "Estimated timing" : "Explicit timing")}
					</p>
					<div className="flex flex-wrap gap-1">
						{shown.version === row.currentVersion ? (
							<Button
								size="sm"
								variant="secondary"
								onClick={() =>
									setDraft({
										content: content(current),
										version: row.currentVersion,
									})
								}
							>
								{t("Edit row")}
							</Button>
						) : (
							<Button
								size="sm"
								onClick={() => {
									if (
										change({
											type: "restoreScriptRow",
											rowId: row.id,
											expectedRowVersion: row.currentVersion,
											version: shown.version,
										})
									)
										setHistory(null);
								}}
							>
								{t("Restore as a new version")}
							</Button>
						)}
						<Button
							size="sm"
							variant="ghost"
							onClick={() =>
								change({
									type: "removeScriptRow",
									rowId: row.id,
									expectedRowVersion: row.currentVersion,
								})
							}
						>
							{t("Remove row")}
						</Button>
					</div>
				</>
			)}
		</article>
	);
}

function ReferenceCard({
	slot,
	projectId,
	change,
	busy,
	selected,
	onSelect,
	onUpload,
}: {
	slot: ReferenceSlot;
	projectId: string;
	change: Change;
	busy: boolean;
	selected: boolean;
	onSelect: (value: boolean) => void;
	onUpload: (file: File) => void;
}) {
	const { t } = useInterfaceLanguage();
	const [draft, setDraft] = useState<{
		label: string;
		purpose: string;
		version: number;
	} | null>(null);
	const version = slot.versions.find(
		(item) => item.version === slot.selectedVersion,
	);
	const approved = !!version && slot.approvedVersion === version.version;
	return (
		<article className={card}>
			<header className="flex items-center justify-between gap-2">
				<label className="flex gap-2">
					<input
						type="checkbox"
						checked={selected}
						disabled={busy}
						onChange={(event) => onSelect(event.target.checked)}
					/>
					<b dir="auto">{slot.label}</b>
				</label>
				<span
					className={
						approved
							? "text-xs text-emerald-500"
							: "text-xs text-muted-foreground"
					}
				>
					{t(approved ? "Approved" : "Needs review")}
				</span>
			</header>
			{version && (
				<img
					alt={slot.label}
					src={fileUrl({ projectId, id: version.referenceId })}
					className="max-h-56 w-full rounded object-contain"
				/>
			)}
			{draft ? (
				<div className="space-y-2">
					<label>
						{t("Reference slot name")}
						<Input
							value={draft.label}
							onChange={(event) =>
								setDraft({ ...draft, label: event.target.value })
							}
						/>
					</label>
					<label className="block">
						{t("Generation brief")}
						<Textarea
							dir="auto"
							value={draft.purpose}
							onChange={(event) =>
								setDraft({ ...draft, purpose: event.target.value })
							}
						/>
					</label>
					{draft.version !== slot.slotVersion && (
						<p role="alert">
							{t("This reference changed. Reopen it before saving.")}
						</p>
					)}
					<Button
						size="sm"
						disabled={draft.version !== slot.slotVersion || busy}
						onClick={() => {
							if (
								change({
									type: "editReferenceSlot",
									slotId: slot.id,
									expectedSlotVersion: draft.version,
									label: draft.label,
									purpose: draft.purpose,
								})
							)
								setDraft(null);
						}}
					>
						{t("Save brief")}
					</Button>{" "}
					<Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
						{t("Cancel")}
					</Button>
				</div>
			) : (
				<>
					<p
						dir="auto"
						className="whitespace-pre-wrap text-xs text-muted-foreground"
					>
						{slot.purpose}
					</p>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={() =>
							setDraft({
								label: slot.label,
								purpose: slot.purpose,
								version: slot.slotVersion,
							})
						}
					>
						{t("Edit brief")}
					</Button>
				</>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<label className="min-w-0 text-xs">
					{t("Upload or replace image")}
					<input
						className="block max-w-full text-xs"
						type="file"
						accept="image/png,image/jpeg,image/webp"
						disabled={busy}
						onChange={(event) => {
							const file = event.currentTarget.files?.[0];
							event.currentTarget.value = "";
							if (file) onUpload(file);
						}}
					/>
				</label>
				{version && (
					<>
						<select
							className={selectClass}
							aria-label={t("Reference version history")}
							disabled={busy}
							value={version.version}
							onChange={(event) =>
								change({
									type: "selectReferenceVersion",
									slotId: slot.id,
									expectedSlotVersion: slot.slotVersion,
									version: Number(event.target.value),
								})
							}
						>
							{slot.versions.map((item) => (
								<option key={item.version} value={item.version}>
									v{item.version} · {item.source}
								</option>
							))}
						</select>
						<Button
							size="sm"
							disabled={busy}
							variant={approved ? "secondary" : "default"}
							onClick={() =>
								change({
									type: "approveReference",
									slotId: slot.id,
									expectedSlotVersion: slot.slotVersion,
									version: version.version,
									approved: !approved,
								})
							}
						>
							{t(approved ? "Revoke approval" : "Approve selected image")}
						</Button>
					</>
				)}
			</div>
		</article>
	);
}
