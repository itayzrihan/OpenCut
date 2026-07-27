"use client";

import { useMemo, useState } from "react";
import {
	Check,
	ChevronLeft,
	ChevronRight,
	Clapperboard,
	Mic2,
	Play,
	SlidersHorizontal,
	Video,
	WandSparkles,
} from "lucide-react";
import {
	normalizePodcastMulticamSettings,
	podcastMulticamDefaults,
} from "opencut-wasm";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useEditor, useEditorProject } from "@/editor/use-editor";
import type { MediaAsset } from "@/media/types";
import {
	runPodcastAlignment,
	runPodcastMulticam,
	type PodcastSyncAlignment,
	type PodcastSyncChannel,
	type PodcastSyncResult,
	type PodcastSyncSettings,
} from "@/podcast-sync/engine";
import { buildPodcastSyncScene } from "@/podcast-sync/scene";
import { cn } from "@/utils/ui";

interface ChannelDraft {
	id: string;
	name: string;
	videoAssetId: string;
	audioAssetId: string;
}

type WizardMode = "quick" | "guided";
type WizardStep = "media" | "sync" | "multicam" | "sequence";

const NONE_VALUE = "none";
const MAX_CHANNELS = 5;
const STEPS: Array<{ id: WizardStep; label: string }> = [
	{ id: "media", label: "Link Files" },
	{ id: "sync", label: "Sync" },
	{ id: "multicam", label: "Multicam" },
	{ id: "sequence", label: "Export" },
];
const CHANNEL_COLORS = ["#6366f1", "#f59e0b", "#22c55e", "#ef4444", "#8b5cf6"];

function baseName(name: string): string {
	return name
		.replace(/\.[^.]+$/, "")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "");
}

function displayBaseName(name: string): string {
	return name.replace(/\.[^.]+$/, "");
}

function findMatchingAudio({
	video,
	audioAssets,
	usedAudioIds,
}: {
	video: MediaAsset;
	audioAssets: MediaAsset[];
	usedAudioIds: Set<string>;
}): MediaAsset | null {
	const videoBase = baseName(video.name);
	return (
		audioAssets.find(
			(asset) =>
				!usedAudioIds.has(asset.id) && baseName(asset.name) === videoBase,
		) ??
		audioAssets.find((asset) => {
			if (usedAudioIds.has(asset.id)) return false;
			const audioBase = baseName(asset.name);
			return audioBase.includes(videoBase) || videoBase.includes(audioBase);
		}) ??
		audioAssets.find((asset) => !usedAudioIds.has(asset.id)) ??
		null
	);
}

function buildInitialDrafts({
	videoAssets,
	audioAssets,
	count,
}: {
	videoAssets: MediaAsset[];
	audioAssets: MediaAsset[];
	count: number;
}): ChannelDraft[] {
	const usedAudioIds = new Set<string>();
	return Array.from({ length: count }, (_, index) => {
		const video = videoAssets[index];
		const audio = video
			? findMatchingAudio({ video, audioAssets, usedAudioIds })
			: null;
		if (audio) usedAudioIds.add(audio.id);
		return {
			id: `channel-${index + 1}`,
			name: video ? displayBaseName(video.name) : `Channel ${index + 1}`,
			videoAssetId: video?.id ?? NONE_VALUE,
			audioAssetId: audio?.id ?? NONE_VALUE,
		};
	});
}

export function PodcastSyncDialog({
	open,
	onOpenChange,
	assets,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	assets: MediaAsset[];
}) {
	const editor = useEditor();
	const activeProject = useEditorProject((e) => e.project.getActive());
	const videoAssets = useMemo(
		() => assets.filter((asset) => asset.type === "video"),
		[assets],
	);
	const audioAssets = useMemo(
		() =>
			assets.filter(
				(asset) =>
					asset.type === "audio" || (asset.type === "video" && asset.hasAudio),
			),
		[assets],
	);
	const suggestedName = activeProject?.metadata.name
		? `${activeProject.metadata.name} Podcast Multicam`
		: "Podcast Multicam";
	const initialCount = Math.min(
		MAX_CHANNELS,
		Math.max(1, videoAssets.length || 2),
	);
	const [mode, setMode] = useState<WizardMode>("quick");
	const [step, setStep] = useState<WizardStep>("media");
	const [channels, setChannels] = useState<ChannelDraft[]>(() =>
		buildInitialDrafts({ videoAssets, audioAssets, count: initialCount }),
	);
	const [settings, setSettings] = useState<PodcastSyncSettings>(() => ({
		...podcastMulticamDefaults({ quick: false }),
		sequenceName: suggestedName,
	}));
	const [alignment, setAlignment] = useState<PodcastSyncAlignment | null>(null);
	const [result, setResult] = useState<PodcastSyncResult | null>(null);
	const [sequenceCreated, setSequenceCreated] = useState(false);
	const [isRunning, setIsRunning] = useState(false);
	const [progress, setProgress] = useState({ step: "", value: 0 });

	const assetById = useMemo(
		() => new Map(assets.map((asset) => [asset.id, asset])),
		[assets],
	);
	const currentStepIndex = STEPS.findIndex((item) => item.id === step);

	const setChannelCount = (nextCount: number) => {
		const count = Math.max(1, Math.min(MAX_CHANNELS, Math.floor(nextCount)));
		setChannels((current) => {
			if (count <= current.length) return current.slice(0, count);
			const allDrafts = buildInitialDrafts({
				videoAssets,
				audioAssets,
				count,
			});
			return [...current, ...allDrafts.slice(current.length)];
		});
	};

	const updateChannel = ({
		channelId,
		patch,
	}: {
		channelId: string;
		patch: Partial<Omit<ChannelDraft, "id">>;
	}) => {
		setChannels((current) =>
			current.map((channel) =>
				channel.id === channelId ? { ...channel, ...patch } : channel,
			),
		);
	};

	const resolveChannels = (): PodcastSyncChannel[] | null => {
		if (!activeProject) {
			toast.error("No active project");
			return null;
		}
		const resolved: PodcastSyncChannel[] = [];
		const usedVideoIds = new Set<string>();
		const usedAudioIds = new Set<string>();
		for (const draft of channels) {
			const video = assetById.get(draft.videoAssetId);
			const audio = assetById.get(draft.audioAssetId);
			if (!video || video.type !== "video") {
				toast.error(`${draft.name} needs a camera video`);
				return null;
			}
			if (!audio || (audio.type !== "audio" && audio.type !== "video")) {
				toast.error(`${draft.name} needs a microphone source`);
				return null;
			}
			if (usedVideoIds.has(video.id)) {
				toast.error(`${video.name} is used by more than one channel`);
				return null;
			}
			if (usedAudioIds.has(audio.id)) {
				toast.error(`${audio.name} is used by more than one channel`);
				return null;
			}
			usedVideoIds.add(video.id);
			usedAudioIds.add(audio.id);
			resolved.push({
				id: draft.id,
				name: draft.name.trim() || displayBaseName(video.name),
				video,
				audio,
			});
		}
		return resolved;
	};

	const normalizedSettings = (quick: boolean): PodcastSyncSettings =>
		normalizePodcastMulticamSettings({
			...(quick ? podcastMulticamDefaults({ quick: true }) : settings),
			sequenceName: settings.sequenceName,
			keepCameraMics: settings.keepCameraMics,
		});

	const createSequence = async ({
		resolvedChannels,
		resolvedSettings,
		resolvedResult,
	}: {
		resolvedChannels: PodcastSyncChannel[];
		resolvedSettings: PodcastSyncSettings;
		resolvedResult: PodcastSyncResult;
	}) => {
		if (sequenceCreated) return;
		const scene = buildPodcastSyncScene({
			name: resolvedSettings.sequenceName,
			channels: resolvedChannels,
			result: resolvedResult,
			keepCameraMics: resolvedSettings.keepCameraMics,
		});
		editor.scenes.setScenes({
			scenes: [...editor.scenes.getScenes(), scene],
			activeSceneId: scene.id,
		});
		await editor.save.flush();
		setSequenceCreated(true);
	};

	const handleRunAlignment = async () => {
		const resolvedChannels = resolveChannels();
		if (!resolvedChannels) return null;
		const resolvedSettings = normalizedSettings(mode === "quick");
		setSettings(resolvedSettings);
		setIsRunning(true);
		setProgress({ step: "Starting synchronization", value: 0 });
		try {
			const nextAlignment = await runPodcastAlignment({
				channels: resolvedChannels,
				settings: resolvedSettings,
				onProgress: ({ step: nextStep, progress: value }) =>
					setProgress({ step: nextStep, value }),
			});
			setAlignment(nextAlignment);
			return { resolvedChannels, resolvedSettings, nextAlignment };
		} catch (error) {
			console.error("Podcast synchronization failed:", error);
			toast.error("Podcast synchronization failed", {
				description: error instanceof Error ? error.message : undefined,
			});
			return null;
		} finally {
			setIsRunning(false);
		}
	};

	const handleRunMulticam = async ({
		alignmentOverride,
		quick = false,
	}: {
		alignmentOverride?: PodcastSyncAlignment;
		quick?: boolean;
	} = {}) => {
		const resolvedChannels = resolveChannels();
		const resolvedAlignment = alignmentOverride ?? alignment;
		if (!resolvedChannels || !resolvedAlignment) return null;
		const resolvedSettings = normalizedSettings(quick);
		setSettings(resolvedSettings);
		setIsRunning(true);
		setProgress({ step: "Starting multicam analysis", value: 0 });
		try {
			const nextResult = await runPodcastMulticam({
				channels: resolvedChannels,
				settings: resolvedSettings,
				alignment: resolvedAlignment,
				onProgress: ({ step: nextStep, progress: value }) =>
					setProgress({ step: nextStep, value }),
			});
			setResult(nextResult);
			return { resolvedChannels, resolvedSettings, nextResult };
		} catch (error) {
			console.error("Podcast multicam analysis failed:", error);
			toast.error("Podcast multicam analysis failed", {
				description: error instanceof Error ? error.message : undefined,
			});
			return null;
		} finally {
			setIsRunning(false);
		}
	};

	const handleAutoEdit = async () => {
		setStep("sync");
		const syncRun = await handleRunAlignment();
		if (!syncRun) return;
		setStep("multicam");
		const multicamRun = await handleRunMulticam({
			alignmentOverride: syncRun.nextAlignment,
			quick: true,
		});
		if (!multicamRun) return;
		setStep("sequence");
		setIsRunning(true);
		try {
			await createSequence({
				resolvedChannels: multicamRun.resolvedChannels,
				resolvedSettings: multicamRun.resolvedSettings,
				resolvedResult: multicamRun.nextResult,
			});
			toast.success("Podcast multicam sequence created", {
				description: `${multicamRun.nextResult.summary.totalCuts} cuts across ${multicamRun.resolvedChannels.length} channels`,
			});
		} catch (error) {
			console.error("Failed to create podcast sequence:", error);
			toast.error("Failed to create podcast sequence");
		} finally {
			setIsRunning(false);
		}
	};

	const handleCreateGuidedSequence = async () => {
		const resolvedChannels = resolveChannels();
		if (!resolvedChannels || !result) return;
		setIsRunning(true);
		try {
			await createSequence({
				resolvedChannels,
				resolvedSettings: normalizedSettings(false),
				resolvedResult: result,
			});
			toast.success("Podcast multicam sequence created");
		} catch (error) {
			console.error("Failed to create podcast sequence:", error);
			toast.error("Failed to create podcast sequence");
		} finally {
			setIsRunning(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => !isRunning && onOpenChange(next)}
		>
			<DialogContent className="max-h-[92vh] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
				<DialogHeader>
					<DialogTitle>Podcast Multicam</DialogTitle>
					<DialogDescription>
						Sync every camera to its microphone, detect the active speaker, and
						build an editable multicam sequence.
					</DialogDescription>
					<WizardSteps currentIndex={currentStepIndex} />
				</DialogHeader>

				<DialogBody className="min-h-0 overflow-y-auto">
					{step === "media" ? (
						<MediaStep
							mode={mode}
							onModeChange={setMode}
							channels={channels}
							settings={settings}
							videoAssets={videoAssets}
							audioAssets={audioAssets}
							onChannelCountChange={setChannelCount}
							onChannelChange={updateChannel}
							onSequenceNameChange={(sequenceName) =>
								setSettings((current) => ({ ...current, sequenceName }))
							}
							onKeepCameraMicsChange={(keepCameraMics) =>
								setSettings((current) => ({ ...current, keepCameraMics }))
							}
						/>
					) : null}
					{step === "sync" ? (
						<SyncStep
							channels={channels}
							assetById={assetById}
							alignment={alignment}
							isRunning={isRunning}
							progress={progress}
							auto={mode === "quick"}
							onRun={handleRunAlignment}
						/>
					) : null}
					{step === "multicam" ? (
						<MulticamStep
							settings={settings}
							result={result}
							channels={channels}
							isRunning={isRunning}
							progress={progress}
							auto={mode === "quick"}
							onSettingsChange={setSettings}
							onRun={() => handleRunMulticam()}
						/>
					) : null}
					{step === "sequence" ? (
						<SequenceStep
							result={result}
							channelCount={channels.length}
							sequenceName={settings.sequenceName}
							created={sequenceCreated}
						/>
					) : null}
				</DialogBody>

				<DialogFooter>
					{step === "media" ? (
						<>
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button
								onClick={() => {
									if (!resolveChannels()) return;
									if (mode === "quick") void handleAutoEdit();
									else setStep("sync");
								}}
							>
								{mode === "quick" ? (
									<>
										<WandSparkles className="size-4" /> Auto Edit
									</>
								) : (
									<>
										Continue to Sync <ChevronRight className="size-4" />
									</>
								)}
							</Button>
						</>
					) : null}
					{step === "sync" && mode === "guided" ? (
						<>
							<Button
								variant="outline"
								onClick={() => setStep("media")}
								disabled={isRunning}
							>
								<ChevronLeft className="size-4" /> Back
							</Button>
							{alignment ? (
								<Button onClick={() => setStep("multicam")}>
									Continue to Multicam <ChevronRight className="size-4" />
								</Button>
							) : (
								<Button
									onClick={() => void handleRunAlignment()}
									disabled={isRunning}
								>
									<Play className="size-4" /> Start Sync
								</Button>
							)}
						</>
					) : null}
					{step === "multicam" && mode === "guided" ? (
						<>
							<Button
								variant="outline"
								onClick={() => setStep("sync")}
								disabled={isRunning}
							>
								<ChevronLeft className="size-4" /> Back
							</Button>
							{result ? (
								<Button onClick={() => setStep("sequence")}>
									Continue <ChevronRight className="size-4" />
								</Button>
							) : (
								<Button
									onClick={() => void handleRunMulticam()}
									disabled={isRunning}
								>
									<Clapperboard className="size-4" /> Analyze & Route Cameras
								</Button>
							)}
						</>
					) : null}
					{step === "sequence" ? (
						<>
							{mode === "guided" && !sequenceCreated ? (
								<Button
									onClick={() => void handleCreateGuidedSequence()}
									disabled={isRunning || !result}
								>
									<Clapperboard className="size-4" /> Create Editable Sequence
								</Button>
							) : null}
							{sequenceCreated ? (
								<Button onClick={() => onOpenChange(false)}>
									Open in Editor
								</Button>
							) : null}
						</>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function WizardSteps({ currentIndex }: { currentIndex: number }) {
	return (
		<div className="mt-4 grid grid-cols-4 gap-2">
			{STEPS.map((item, index) => (
				<div key={item.id} className="flex items-center gap-2">
					<div
						className={cn(
							"flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
							index < currentIndex &&
								"border-primary bg-primary text-primary-foreground",
							index === currentIndex && "border-primary text-primary",
							index > currentIndex && "text-muted-foreground",
						)}
					>
						{index < currentIndex ? <Check className="size-3.5" /> : index + 1}
					</div>
					<span
						className={cn(
							"text-xs",
							index !== currentIndex && "text-muted-foreground",
						)}
					>
						{item.label}
					</span>
				</div>
			))}
		</div>
	);
}

function MediaStep({
	mode,
	onModeChange,
	channels,
	settings,
	videoAssets,
	audioAssets,
	onChannelCountChange,
	onChannelChange,
	onSequenceNameChange,
	onKeepCameraMicsChange,
}: {
	mode: WizardMode;
	onModeChange: (mode: WizardMode) => void;
	channels: ChannelDraft[];
	settings: PodcastSyncSettings;
	videoAssets: MediaAsset[];
	audioAssets: MediaAsset[];
	onChannelCountChange: (count: number) => void;
	onChannelChange: (args: {
		channelId: string;
		patch: Partial<Omit<ChannelDraft, "id">>;
	}) => void;
	onSequenceNameChange: (name: string) => void;
	onKeepCameraMicsChange: (keep: boolean) => void;
}) {
	return (
		<div className="space-y-5">
			<div className="grid gap-3 md:grid-cols-[1fr_160px]">
				<div className="space-y-1.5">
					<Label>Sequence name</Label>
					<Input
						value={settings.sequenceName}
						onChange={(event) => onSequenceNameChange(event.target.value)}
					/>
				</div>
				<div className="space-y-1.5">
					<Label>Number of channels</Label>
					<Select
						value={String(channels.length)}
						onValueChange={(value) => onChannelCountChange(Number(value))}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Array.from(
								{ length: MAX_CHANNELS },
								(_, index) => index + 1,
							).map((count) => (
								<SelectItem key={count} value={String(count)}>
									{count} {count === 1 ? "channel" : "channels"}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			<div className="grid gap-3 md:grid-cols-2">
				<ModeCard
					selected={mode === "quick"}
					icon={<WandSparkles className="size-5" />}
					title="Quick Auto Edit"
					description="One click runs sync and multicam with the original app defaults, then creates the sequence."
					onClick={() => onModeChange("quick")}
				/>
				<ModeCard
					selected={mode === "guided"}
					icon={<SlidersHorizontal className="size-5" />}
					title="Step by Step"
					description="Review synchronization first, then choose multicam behavior before creating the sequence."
					onClick={() => onModeChange("guided")}
				/>
			</div>

			<div className="space-y-3">
				<div>
					<h3 className="text-sm font-medium">Channel media</h3>
					<p className="text-muted-foreground text-xs">
						Choose one camera video and its professional microphone for every
						channel.
					</p>
				</div>
				{channels.map((channel, index) => (
					<div
						key={channel.id}
						className="grid gap-2 rounded-lg border p-3 md:grid-cols-[1fr_1.25fr_1.25fr]"
					>
						<div className="space-y-1.5">
							<Label>Channel {index + 1}</Label>
							<Input
								value={channel.name}
								onChange={(event) =>
									onChannelChange({
										channelId: channel.id,
										patch: { name: event.target.value },
									})
								}
							/>
						</div>
						<div className="space-y-1.5">
							<Label className="flex items-center gap-1.5">
								<Video className="size-3.5" /> Camera video
							</Label>
							<Select
								value={channel.videoAssetId}
								onValueChange={(value) =>
									onChannelChange({
										channelId: channel.id,
										patch: { videoAssetId: value },
									})
								}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Choose video" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={NONE_VALUE}>Choose video</SelectItem>
									{videoAssets.map((asset) => (
										<SelectItem key={asset.id} value={asset.id}>
											{asset.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1.5">
							<Label className="flex items-center gap-1.5">
								<Mic2 className="size-3.5" /> Professional mic
							</Label>
							<Select
								value={channel.audioAssetId}
								onValueChange={(value) =>
									onChannelChange({
										channelId: channel.id,
										patch: { audioAssetId: value },
									})
								}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Choose audio" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={NONE_VALUE}>Choose audio</SelectItem>
									{audioAssets.map((asset) => (
										<SelectItem key={asset.id} value={asset.id}>
											{asset.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
				))}
				{assetsMissing({ videoAssets, audioAssets }) ? (
					<p className="text-muted-foreground rounded-md border border-dashed p-3 text-xs">
						Import camera videos and microphone recordings into Assets, then
						reopen Podcast Multicam.
					</p>
				) : null}
				<div className="flex items-center justify-between rounded-lg border px-3 py-2">
					<div>
						<Label>Keep camera microphones</Label>
						<p className="text-muted-foreground text-xs">
							Keep each camera&apos;s built-in audio alongside the professional
							mic tracks.
						</p>
					</div>
					<Switch
						checked={settings.keepCameraMics}
						onCheckedChange={onKeepCameraMicsChange}
					/>
				</div>
			</div>
		</div>
	);
}

function assetsMissing({
	videoAssets,
	audioAssets,
}: {
	videoAssets: MediaAsset[];
	audioAssets: MediaAsset[];
}) {
	return videoAssets.length === 0 || audioAssets.length === 0;
}

function ModeCard({
	selected,
	icon,
	title,
	description,
	onClick,
}: {
	selected: boolean;
	icon: React.ReactNode;
	title: string;
	description: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"rounded-xl border p-4 text-left transition-colors",
				selected ? "border-primary bg-primary/5" : "hover:bg-accent/40",
			)}
		>
			<div className="mb-2 flex items-center gap-2 font-medium">
				{icon}
				{title}
				{selected ? <Check className="text-primary ml-auto size-4" /> : null}
			</div>
			<p className="text-muted-foreground text-xs leading-relaxed">
				{description}
			</p>
		</button>
	);
}

function SyncStep({
	channels,
	assetById,
	alignment,
	isRunning,
	progress,
	auto,
	onRun,
}: {
	channels: ChannelDraft[];
	assetById: Map<string, MediaAsset>;
	alignment: PodcastSyncAlignment | null;
	isRunning: boolean;
	progress: { step: string; value: number };
	auto: boolean;
	onRun: () => Promise<unknown>;
}) {
	return (
		<div className="space-y-5">
			<div>
				<h3 className="font-medium">Synchronization</h3>
				<p className="text-muted-foreground text-sm">
					Camera audio aligns all angles to one timeline; each professional mic
					is then aligned to its camera.
				</p>
			</div>
			{isRunning || auto ? <ProgressPanel progress={progress} /> : null}
			<div className="overflow-hidden rounded-lg border">
				<div className="grid grid-cols-[1fr_1.5fr_1.5fr] gap-3 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
					<span>Channel</span>
					<span>Camera</span>
					<span>Microphone</span>
				</div>
				{channels.map((channel) => (
					<div
						key={channel.id}
						className="grid grid-cols-[1fr_1.5fr_1.5fr] gap-3 border-t px-3 py-2 text-sm"
					>
						<span>{channel.name}</span>
						<span className="truncate">
							{assetById.get(channel.videoAssetId)?.name}
						</span>
						<span className="truncate">
							{assetById.get(channel.audioAssetId)?.name}
						</span>
					</div>
				))}
			</div>
			{alignment ? (
				<div className="space-y-2">
					<h4 className="text-sm font-medium">Sync results</h4>
					<div className="overflow-hidden rounded-lg border">
						<div className="grid grid-cols-3 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
							<span>Channel</span>
							<span>Video trim</span>
							<span>Audio trim / delay</span>
						</div>
						{channels.map((channel) => (
							<div
								key={channel.id}
								className="grid grid-cols-3 border-t px-3 py-2 text-sm"
							>
								<span>{channel.name}</span>
								<span>
									{(alignment.videoOffsets[channel.id] ?? 0).toFixed(2)}s
								</span>
								<span>
									{(alignment.audioOffsets[channel.id] ?? 0).toFixed(2)}s /{" "}
									{(alignment.audioDelays[channel.id] ?? 0).toFixed(2)}s
								</span>
							</div>
						))}
					</div>
				</div>
			) : null}
			{!alignment && !isRunning && !auto ? (
				<Button variant="outline" onClick={() => void onRun()}>
					<Play className="size-4" /> Run synchronization
				</Button>
			) : null}
		</div>
	);
}

function MulticamStep({
	settings,
	result,
	channels,
	isRunning,
	progress,
	auto,
	onSettingsChange,
	onRun,
}: {
	settings: PodcastSyncSettings;
	result: PodcastSyncResult | null;
	channels: ChannelDraft[];
	isRunning: boolean;
	progress: { step: string; value: number };
	auto: boolean;
	onSettingsChange: (settings: PodcastSyncSettings) => void;
	onRun: () => Promise<unknown>;
}) {
	return (
		<div className="space-y-5">
			<div>
				<h3 className="font-medium">Multicam Settings & Analysis</h3>
				<p className="text-muted-foreground text-sm">
					Detect who is speaking and route the active camera while suppressing
					microphone bleed.
				</p>
			</div>
			{isRunning || auto ? <ProgressPanel progress={progress} /> : null}
			{!auto ? (
				<div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
					<NumberSetting
						label="Min cut (seconds)"
						value={settings.minCutDuration}
						min={0.5}
						max={10}
						step={0.1}
						disabled={isRunning || !!result}
						onChange={(minCutDuration) =>
							onSettingsChange({ ...settings, minCutDuration })
						}
					/>
					<NumberSetting
						label="Pre-roll (seconds)"
						value={settings.preRoll}
						min={0}
						max={1}
						step={0.05}
						disabled={isRunning || !!result}
						onChange={(preRoll) => onSettingsChange({ ...settings, preRoll })}
					/>
					<div className="space-y-1.5">
						<Label>Crosstalk</Label>
						<Select
							value={settings.crosstalkBehavior}
							disabled={isRunning || !!result}
							onValueChange={(crosstalkBehavior) =>
								onSettingsChange({ ...settings, crosstalkBehavior })
							}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="stay">Stay on current</SelectItem>
								<SelectItem value="priority">
									Lowest channel priority
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-1.5">
						<Label>Silence</Label>
						<Select value={settings.silenceBehavior} disabled>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="stay_on_last">
									Stay on last speaker
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="flex items-end justify-between rounded-md border px-3 py-2">
						<Label>Anti-bleed</Label>
						<Switch
							checked={settings.antiBleed}
							disabled={isRunning || !!result}
							onCheckedChange={(antiBleed) =>
								onSettingsChange({ ...settings, antiBleed })
							}
						/>
					</div>
				</div>
			) : null}
			{!result && !isRunning && !auto ? (
				<Button variant="outline" onClick={() => void onRun()}>
					<Clapperboard className="size-4" /> Analyze & Route Cameras
				</Button>
			) : null}
			{result ? <CutTimeline result={result} channels={channels} /> : null}
		</div>
	);
}

function CutTimeline({
	result,
	channels,
}: {
	result: PodcastSyncResult;
	channels: ChannelDraft[];
}) {
	const channelIndex = new Map(
		channels.map((channel, index) => [channel.id, index]),
	);
	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<h4 className="text-sm font-medium">Camera timeline</h4>
				<span className="text-muted-foreground text-xs">
					{result.summary.totalCuts} cuts · {result.duration.toFixed(1)}s
				</span>
			</div>
			<div className="flex h-12 overflow-hidden rounded-md border bg-muted/30">
				{result.cuts.map((cut, index) => (
					<div
						key={`${cut.timestamp}-${index}`}
						title={`${cut.channelId} @ ${cut.timestamp.toFixed(1)}s (${cut.duration.toFixed(1)}s)`}
						style={{
							width: `${(cut.duration / result.duration) * 100}%`,
							backgroundColor:
								CHANNEL_COLORS[channelIndex.get(cut.channelId) ?? 0],
						}}
					/>
				))}
			</div>
			<div className="flex flex-wrap gap-3">
				{channels.map((channel, index) => (
					<div key={channel.id} className="flex items-center gap-1.5 text-xs">
						<span
							className="size-2.5 rounded-sm"
							style={{ backgroundColor: CHANNEL_COLORS[index] }}
						/>
						{channel.name}
					</div>
				))}
			</div>
		</div>
	);
}

function SequenceStep({
	result,
	channelCount,
	sequenceName,
	created,
}: {
	result: PodcastSyncResult | null;
	channelCount: number;
	sequenceName: string;
	created: boolean;
}) {
	return (
		<div className="flex min-h-64 flex-col items-center justify-center text-center">
			<div
				className={cn(
					"mb-4 flex size-12 items-center justify-center rounded-full",
					created
						? "bg-emerald-500/10 text-emerald-500"
						: "bg-primary/10 text-primary",
				)}
			>
				{created ? (
					<Check className="size-6" />
				) : (
					<Clapperboard className="size-6" />
				)}
			</div>
			<h3 className="font-medium">
				{created ? "Podcast multicam is ready" : "Ready to create the sequence"}
			</h3>
			<p className="text-muted-foreground mt-2 max-w-md text-sm">
				{created
					? `“${sequenceName}” is open in the editor with routed and leftover camera tracks plus continuous microphone audio.`
					: `${result?.summary.totalCuts ?? 0} cuts across ${channelCount} channels are ready for an editable PoCut sequence.`}
			</p>
		</div>
	);
}

function ProgressPanel({
	progress,
}: {
	progress: { step: string; value: number };
}) {
	return (
		<div className="space-y-2 rounded-lg border p-3">
			<div className="flex justify-between text-xs text-muted-foreground">
				<span>{progress.step}</span>
				<span>{Math.round(progress.value * 100)}%</span>
			</div>
			<Progress value={Math.round(progress.value * 100)} />
		</div>
	);
}

function NumberSetting({
	label,
	value,
	min,
	max,
	step,
	disabled,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	disabled: boolean;
	onChange: (value: number) => void;
}) {
	return (
		<div className="space-y-1.5">
			<Label>{label}</Label>
			<Input
				type="number"
				value={value}
				min={min}
				max={max}
				step={step}
				disabled={disabled}
				onChange={(event) => onChange(Number(event.target.value))}
			/>
		</div>
	);
}
