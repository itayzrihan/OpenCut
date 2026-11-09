"use client";

import { LocalizedValue as UiValue } from "@/i18n/message";
import { localizeClientMessage } from "@/i18n/client-messages";
import {
	LocalizedElement as UiLocalized,
	Message as UiMessage,
} from "@/i18n/message";
import { useEffect, useState, useRef } from "react";
import { TransitionTopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/utils/ui";
import {
	getExportMimeType,
	getExportFileExtension,
	downloadBuffer,
	hasExportOutput,
	type ExportResult,
} from "@/export";
import { downloadBlob } from "@/utils/browser";
import { toast } from "@/i18n/toast";
import {
	Check,
	Copy,
	Download,
	RotateCcw,
	ListVideo,
	ListPlus,
} from "lucide-react";
import type { ExportFormat, ExportQuality } from "@/export";
import {
	ExportSettingsFields,
	ExportPlanSummary,
} from "@/export/settings-fields";
import { useEditor, useEditorProject } from "@/editor/use-editor";
import { checkExportEncoder } from "@/export/video-encoding";
import type { ExportPlan, ExportPreferences } from "@/export";
import { enqueueCurrentRender, openRenderQueue } from "@/export/queue/client";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";

export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const editor = useEditor();
	const activeProject = useEditorProject((e) => e.project.getActiveOrNull());
	const hasProject = !!activeProject;

	const handlePopoverOpenChange = ({ open }: { open: boolean }) => {
		// Closing a popover must not destroy hours of export work.
		if (!open && editor.project.getExportState().isExporting) return;
		setIsExportPopoverOpen(open);
	};

	return (
		<div className="flex items-center gap-1">
			<UiLocalized<typeof Button>
				element={Button}
				messageProps={["aria-label", "title"]}
				variant="ghost"
				size="icon"
				aria-label="Open Render Queue"
				title="Render Queue"
				onClick={openRenderQueue}
			>
				<ListVideo />
			</UiLocalized>
			<Popover
				open={isExportPopoverOpen}
				onOpenChange={(open) => handlePopoverOpenChange({ open })}
			>
				<PopoverTrigger asChild>
					<button
						type="button"
						className={cn(
							"flex items-center rounded-lg border border-primary/55 bg-primary font-semibold text-primary-foreground outline-none enabled:hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
							hasProject ? "cursor-pointer" : "cursor-not-allowed opacity-50",
						)}
						onClick={
							hasProject ? () => setIsExportPopoverOpen(true) : undefined
						}
						disabled={!hasProject}
						onKeyDown={(event) => {
							if (hasProject && (event.key === "Enter" || event.key === " ")) {
								event.preventDefault();
								setIsExportPopoverOpen(true);
							}
						}}
					>
						<div className="relative flex min-h-8 items-center gap-1.5 px-3">
							<HugeiconsIcon icon={TransitionTopIcon} className="size-3.5" />
							<span className="text-sm">
								<UiMessage text={"Export"} />
							</span>
						</div>
					</button>
				</PopoverTrigger>
				{hasProject && <ExportPopover onOpenChange={setIsExportPopoverOpen} />}
			</Popover>
		</div>
	);
}

function ExportPopover({
	onOpenChange,
}: {
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const [activeProject, exportState] = useEditorProject((e) => [
		e.project.getActive(),
		e.project.getExportState(),
	]);
	const { isExporting, progress, result: exportResult } = exportState;
	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [quality, setQuality] = useState<ExportQuality>("very_high");
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);
	const preferences: ExportPreferences = activeProject.settings
		.exportPreferences ?? { resolution: "source", encoding: "compact" };
	const updatePreferences = (patch: Partial<ExportPreferences>) =>
		editor.project.updateSettings({
			settings: { exportPreferences: { ...preferences, ...patch } },
		});
	let plan: ExportPlan | undefined;
	let planError: string | undefined;
	try {
		plan = editor.command.planExport({
			sceneId: editor.scenes.getActiveScene().id,
			preferences,
			quality,
			format,
		});
	} catch (error) {
		planError =
			error instanceof Error ? error.message : "Could not plan export";
	}
	const planKey = JSON.stringify(plan);
	const [encoderState, setEncoderState] = useState<{
		key: string | undefined;
		error: string | null;
	}>({ key: undefined, error: null });
	useEffect(() => {
		let active = true;
		if (planKey) {
			void checkExportEncoder(JSON.parse(planKey) as ExportPlan).then(
				(error) => {
					if (active) setEncoderState({ key: planKey, error });
				},
			);
		}
		return () => {
			active = false;
		};
	}, [planKey]);
	const checkingEncoder = !!planKey && encoderState.key !== planKey;
	const encoderError = encoderState.key === planKey ? encoderState.error : null;
	const hasReadyExport = hasExportOutput(exportResult);
	const [isQueueing, setIsQueueing] = useState(false);
	const submissionId = useRef<string | null>(null);
	const handleEnqueue = async () => {
		if (!plan || isQueueing || checkingEncoder || encoderError || planError)
			return;
		openRenderQueue();
		setIsQueueing(true);
		try {
			submissionId.current ??= crypto.randomUUID();
			await enqueueCurrentRender({
				editor,
				id: submissionId.current,
				options: {
					preferences,
					format,
					quality,
					fps: activeProject.settings.fps,
					includeAudio: shouldIncludeAudio,
				},
			});
			submissionId.current = null;
			toast.success("Scene snapshot added to Render Queue");
			onOpenChange(false);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not add render job",
			);
		} finally {
			setIsQueueing(false);
		}
	};

	const handleExport = async () => {
		if (!activeProject || !plan || checkingEncoder || encoderError || planError)
			return;

		let destination: FileSystemFileHandle | undefined;
		// The picker must run during this click's user activation, before audio
		// preparation. All subsequent writes go straight to the chosen file.
		try {
			const picker = (
				window as Window & {
					showSaveFilePicker?: (options: {
						suggestedName: string;
						types: { description: string; accept: Record<string, string[]> }[];
					}) => Promise<FileSystemFileHandle>;
				}
			).showSaveFilePicker;
			if (picker)
				destination = await picker.call(window, {
					suggestedName: `${activeProject.metadata.name}.${format}`,
					types: [
						{
							description: "Video",
							accept: { [getExportMimeType({ format })]: [`.${format}`] },
						},
					],
				});
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "AbortError"))
				toast.error(
					error instanceof Error
						? error.message
						: "Could not choose an export file",
				);
			return;
		}
		if (!activeProject.settings.exportPreferences)
			updatePreferences(preferences);
		const result = await editor.project.export({
			destination,
			options: {
				preferences,
				format,
				quality,
				fps: activeProject.settings.fps,
				includeAudio: shouldIncludeAudio,
			},
		});

		if (result.cancelled) {
			editor.project.clearExportState();
			return;
		}

		if (hasExportOutput(result)) {
			deliverExport({ result, readyFormat: format });
		}
	};

	const deliverExport = ({
		result,
		readyFormat,
	}: {
		result: ExportResult;
		readyFormat: ExportFormat;
	}) => {
		const filename = `${activeProject.metadata.name}${getExportFileExtension({ format: readyFormat })}`;
		if (result.savedFileName)
			toast.success(
				localizeClientMessage("Saved {v0}", {
					v0: String(result.savedFileName),
				}),
			);
		else if (result.file) downloadBlob({ blob: result.file, filename });
		else if (result.buffer)
			downloadBuffer({
				buffer: result.buffer,
				filename,
				mimeType: getExportMimeType({ format: readyFormat }),
			});
		editor.project.clearExportState();
		onOpenChange(false);
	};

	const handleCancel = () => {
		editor.project.cancelExport();
	};

	const handleDownloadReadyExport = () => {
		if (exportResult && hasExportOutput(exportResult))
			deliverExport({
				result: exportResult,
				readyFormat: exportState.options?.format ?? format,
			});
	};

	return (
		<PopoverContent className="bg-background mr-4 flex w-96 max-h-[85vh] overflow-y-auto flex-col p-0">
			{exportResult && !exportResult.success ? (
				<ExportError
					error={exportResult.error || "Unknown error occurred"}
					onRetry={handleExport}
				/>
			) : (
				<>
					<div className="flex items-center justify-between p-3 border-b">
						<h3 className="font-medium text-sm">
							{isExporting ? (
								<UiMessage text={"Exporting project"} />
							) : (
								<UiMessage text={"Export project"} />
							)}
						</h3>
					</div>

					<div className="flex flex-col gap-4">
						{!isExporting && !hasReadyExport && (
							<>
								<div className="p-3 space-y-3">
									<ExportSettingsFields
										value={{
											format,
											quality,
											preferences,
											includeAudio: shouldIncludeAudio,
										}}
										onChange={(next) => {
											setFormat(next.format);
											setQuality(next.quality);
											setShouldIncludeAudio(next.includeAudio);
											if (
												next.preferences.resolution !==
													preferences.resolution ||
												next.preferences.encoding !== preferences.encoding
											)
												updatePreferences(next.preferences);
										}}
									/>
									{plan && <ExportPlanSummary plan={plan} />}
									{checkingEncoder && (
										<p className="text-xs">
											<UiMessage text={"Checking encoder support…"} />
										</p>
									)}
									{(planError || encoderError) && (
										<p role="alert" className="text-xs text-destructive">
											{planError || encoderError}
										</p>
									)}
								</div>
								<div className="p-3 pt-0 space-y-2">
									<Button
										onClick={handleEnqueue}
										disabled={
											isQueueing ||
											!plan ||
											checkingEncoder ||
											!!encoderError ||
											!!planError
										}
										className="w-full gap-2"
									>
										<ListPlus className="size-4" />
										{isQueueing ? (
											<UiMessage text={"Adding snapshot…"} />
										) : (
											<UiMessage text={"Add to Render Queue"} />
										)}
									</Button>
									<p className="text-xs text-muted-foreground">
										<UiMessage
											text={
												"Renders this scene as it is now. Continue editing while the queue runs in its own window."
											}
										/>
									</p>
									<Button
										onClick={handleExport}
										variant="outline"
										disabled={
											!plan || checkingEncoder || !!encoderError || !!planError
										}
										className="w-full gap-2"
									>
										<Download className="size-4" />
										<UiMessage text={"Export"} />
									</Button>
								</div>
							</>
						)}

						{!isExporting && hasReadyExport && (
							<div className="space-y-3 p-3">
								<div>
									<p className="text-sm font-medium">
										<UiMessage text={"Export ready"} />
									</p>
									<p className="text-muted-foreground mt-1 text-xs">
										<UiMessage
											text={"Your rendered file is ready for download."}
										/>
									</p>
								</div>
								<Button
									onClick={handleDownloadReadyExport}
									className="w-full gap-2"
								>
									<Download className="size-4" />
									<UiMessage text={"Download export"} />
								</Button>
							</div>
						)}

						{isExporting && (
							<div className="space-y-4 p-3">
								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between text-center">
										<p className="text-muted-foreground text-sm">
											{exportState.phase ?? <UiMessage text={"Exporting"} />} ·{" "}
											{(progress * 100).toFixed(1)}%
										</p>
										<p className="text-muted-foreground text-sm">100%</p>
									</div>
									<Progress value={progress * 100} className="w-full" />
								</div>

								<Button
									variant="outline"
									className="w-full rounded-md"
									onClick={handleCancel}
								>
									<UiMessage text={"Cancel"} />
								</Button>
							</div>
						)}
					</div>
				</>
			)}
		</PopoverContent>
	);
}

function ExportError({
	error,
	onRetry,
}: {
	error: string;
	onRetry: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-3">
			<div className="flex flex-col gap-1.5">
				<p className="text-destructive text-sm font-medium">
					<UiMessage text={"Export failed"} />
				</p>
				<p className="text-muted-foreground text-xs">
					<UiValue>{error}</UiValue>
				</p>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					<UiMessage text={"Copy"} />
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					<UiMessage text={"Retry"} />
				</Button>
			</div>
		</div>
	);
}
