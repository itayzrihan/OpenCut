import { useEffect, useRef, useState, type ReactElement } from "react";
import { Clapperboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useEditor } from "@/editor/use-editor";
import { useInterfaceLanguage } from "@/i18n/provider";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import type { DirectorBatch } from "../types";
import { api, canonical, scope } from "../client";
import { useDirectorReviewFocus } from "../review-focus";
import { prepareSeamless, type SeamlessSelection } from "../seamless-connect";
import {
	seamlessDurations,
	seamlessModelIds,
	supportsSeamless,
	type VideoGenerationModel,
} from "../seamless-models";

export function SeamlessConnectControl(pair: SeamlessSelection) {
	const [open, setOpen] = useState(false);
	return (
		<SeamlessConnectDialog
			{...pair}
			open={open}
			onOpenChange={setOpen}
			trigger={
				<Button variant="outline" size="sm" className="shrink-0">
					<Clapperboard aria-hidden="true" /> Seamless Connect
				</Button>
			}
		/>
	);
}

export function SeamlessConnectDialog({
	pairs,
	open,
	onOpenChange,
	trigger,
}: SeamlessSelection & {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	trigger?: ReactElement;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
			{open && <SeamlessForm pairs={pairs} close={() => onOpenChange(false)} />}
		</Dialog>
	);
}

function SeamlessForm({
	pairs,
	close,
}: {
	pairs: SeamlessSelection["pairs"];
	close: () => void;
}) {
	const editor = useEditor();
	const { t } = useInterfaceLanguage();
	const [catalog, setCatalog] = useState<VideoGenerationModel[]>([]);
	const [modelId, setModelId] = useState<string>(seamlessModelIds[0]);
	const [seconds, setSeconds] = useState(0);
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [selectedCuts, setSelectedCuts] = useState(() =>
		pairs.map((_, index) => index).slice(0, 10),
	);
	const [error, setError] = useState("");
	const abort = useRef<AbortController | null>(null);
	const model = catalog.find((item) => item.id === modelId) ?? catalog[0];
	const durations = seamlessDurations(model);
	const duration = durations.includes(seconds) ? seconds : durations[0];
	const resolution = ["720p", "1080p", "480p"].find((size) =>
		model?.supported_resolutions?.includes(size),
	);

	useEffect(() => {
		const controller = new AbortController();
		void Promise.resolve()
			.then(async () => {
				const { projectId, accountId } = scope(editor);
				const response = await fetch(
					"/api/generative?" + new URLSearchParams({ projectId, models: "1" }),
					{
						headers: { "X-OpenCut-Account": accountId },
						signal: controller.signal,
					},
				);
				const result: { models?: VideoGenerationModel[]; error?: string } =
					await response.json();
				if (!response.ok || !result.models)
					throw new Error(result.error ?? "Video model catalog unavailable");
				const available = seamlessModelIds.flatMap((id) => {
					const item = result.models?.find((candidate) => candidate.id === id);
					return item && supportsSeamless(item) ? [item] : [];
				});
				if (!available.length)
					throw new Error("No compatible video models are available");
				if (!controller.signal.aborted) setCatalog(available);
			})
			.catch((failure) => {
				if (!controller.signal.aborted)
					setError(
						failure instanceof Error ? failure.message : String(failure),
					);
			});
		return () => {
			controller.abort();
			abort.current?.abort();
		};
	}, [editor]);

	async function prepare() {
		if (
			!model ||
			!duration ||
			!resolution ||
			!selectedCuts.length ||
			abort.current
		)
			return;
		const controller = new AbortController();
		abort.current = controller;
		setBusy(true);
		setError("");
		try {
			const original = scope(editor);
			const jobs = [];
			// Prepare all frame pairs before any request can be approved or charged.
			for (const pair of pairs.filter((_, index) =>
				selectedCuts.includes(index),
			)) {
				const job = await prepareSeamless({
					editor,
					...pair,
					model,
					duration,
					resolution,
					prompt,
					signal: controller.signal,
				});
				jobs.push(job);
				canonical({
					editor,
					change: {
						type: "job",
						job: { id: job.id, digest: job.digest, status: "review" },
					},
				});
			}
			if (jobs.length > 1) {
				await api<{ batch: DirectorBatch }>({
					projectId: original.projectId,
					action: "prepare-batch",
					signal: controller.signal,
					data: {
						batch: {
							id: crypto.randomUUID().replaceAll("-", ""),
							kind: "seamless",
							jobs: jobs.map((j) => ({ id: j.id, digest: j.digest })),
						},
					},
				});
			} else
				useDirectorReviewFocus
					.getState()
					.reveal({ ...original, jobId: jobs[0].id });
			useAssetsPanelStore.getState().setActiveTab("generative");
			close();
		} catch (failure) {
			if (!controller.signal.aborted)
				setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			abort.current = null;
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	return (
		<DialogContent className="max-h-[90dvh] overflow-y-auto">
			<DialogHeader className="pe-14">
				<DialogTitle>Seamless Connect</DialogTitle>
				<DialogDescription>
					{t(
						"Generate a bridge from the last frame of the first clip to the first frame of the next clip.",
					)}
				</DialogDescription>
			</DialogHeader>
			<form
				className="min-w-0 space-y-4 p-6"
				onSubmit={(event) => {
					event.preventDefault();
					void prepare();
				}}
			>
				<fieldset className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-3 text-sm">
					<legend>{t("Choose up to ten cuts")}</legend>
					{pairs.map((pair, index) => (
						<label
							key={`${pair.left.id}:${pair.right.id}`}
							className="flex items-center gap-2"
						>
							<input
								type="checkbox"
								checked={selectedCuts.includes(index)}
								disabled={
									busy ||
									(!selectedCuts.includes(index) && selectedCuts.length >= 10)
								}
								onChange={(event) =>
									setSelectedCuts((old) =>
										event.target.checked
											? [...old, index].sort((a, b) => a - b)
											: old.filter((value) => value !== index),
									)
								}
							/>
							<span>
								{pair.left.name} → {pair.right.name}
							</span>
						</label>
					))}
				</fieldset>
				<div className="grid gap-3 sm:grid-cols-2">
					<label className="grid min-w-0 gap-1.5 text-sm">
						{t("Video model")}
						<select
							className="w-full rounded border bg-background p-2"
							value={model?.id ?? ""}
							disabled={!catalog.length || busy}
							onChange={(event) => {
								setModelId(event.target.value);
								setSeconds(0);
							}}
						>
							{catalog.map((item) => (
								<option key={item.id} value={item.id}>
									{item.name || item.id}
								</option>
							))}
						</select>
					</label>
					<label className="grid min-w-0 gap-1.5 text-sm">
						{t("Duration (seconds)")}
						<select
							className="w-full rounded border bg-background p-2"
							value={duration ?? ""}
							disabled={!duration || busy}
							onChange={(event) => setSeconds(Number(event.target.value))}
						>
							{durations.map((value) => (
								<option key={value} value={value}>
									{value}
								</option>
							))}
						</select>
					</label>
				</div>
				<label className="grid gap-1.5 text-sm">
					{t("What should happen between the clips?")}
					<Textarea
						value={prompt}
						maxLength={12000}
						disabled={busy}
						placeholder={t("Leave blank for a natural transition.")}
						onChange={(event) => setPrompt(event.target.value)}
					/>
				</label>
				<p className="text-xs text-muted-foreground">
					{t(
						"Only the two frames and your instructions are sent after approval in The Director. The generated bridge is silent. Later clips move together.",
					)}
				</p>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{t(error)}
					</p>
				)}
				<div className="flex justify-end">
					<Button type="submit" disabled={!model || !resolution || busy}>
						{busy ? t("Capturing boundary frames…") : t("Prepare for review")}
					</Button>
				</div>
			</form>
		</DialogContent>
	);
}
