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
import type { VideoElement } from "@/timeline/types";
import { canonical, scope } from "../client";
import { useDirectorReviewFocus } from "../review-focus";
import { prepareSeamless, type SeamlessPair } from "../seamless-connect";
import {
	seamlessDurations,
	seamlessModelIds,
	supportsSeamless,
	type VideoGenerationModel,
} from "../seamless-models";

export function SeamlessConnectControl(pair: SeamlessPair) {
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
	trackId,
	left,
	right,
	open,
	onOpenChange,
	trigger,
}: SeamlessPair & {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	trigger?: ReactElement;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
			{open && (
				<SeamlessForm
					trackId={trackId}
					left={left}
					right={right}
					close={() => onOpenChange(false)}
				/>
			)}
		</Dialog>
	);
}

function SeamlessForm({
	trackId,
	left,
	right,
	close,
}: {
	trackId: string;
	left: VideoElement;
	right: VideoElement;
	close: () => void;
}) {
	const editor = useEditor();
	const { t } = useInterfaceLanguage();
	const [catalog, setCatalog] = useState<VideoGenerationModel[]>([]);
	const [modelId, setModelId] = useState<string>(seamlessModelIds[0]);
	const [seconds, setSeconds] = useState(0);
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
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
		if (!model || !duration || !resolution || abort.current) return;
		const controller = new AbortController();
		abort.current = controller;
		setBusy(true);
		setError("");
		try {
			const original = scope(editor);
			const job = await prepareSeamless({
				editor,
				trackId,
				left,
				right,
				model,
				duration,
				resolution,
				prompt,
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
				<p className="rounded-lg border bg-background px-3 py-2 text-sm break-words">
					{left.name} → {right.name}
				</p>
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
