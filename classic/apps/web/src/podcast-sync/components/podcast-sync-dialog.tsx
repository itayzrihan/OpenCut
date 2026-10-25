"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { registerLocalMediaPaths } from "@/services/local-drive/client";
import { processLocalDriveMedia } from "@/media/processing";
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
	resolvePodcastChannelSources,
	runPodcastMulticam,
	type PodcastSyncAlignment,
	type PodcastSyncChannel,
	type PodcastSyncResult,
	type PodcastSyncSettings,
} from "@/podcast-sync/engine";
import { cn } from "@/utils/ui";
import { PodcastFinishPanel } from "./podcast-finish-panel";

interface ChannelDraft {
	id: string;
	name: string;
	videoAssetId: string;
	audioAssetId: string;
	/** Only a manual selection may opt into camera audio when external mics exist. */
	audioExplicit: boolean;
	microphoneIds?: string[];
}

type WizardMode = "quick" | "guided" | "advanced";
type WizardStep = "media" | "sync" | "multicam" | "sequence";

const NONE_VALUE = "none";
const MAX_CHANNELS = 32;
const STEPS: Array<{ id: WizardStep; label: string }> = [
	{ id: "media", label: "Link Files" },
	{ id: "sync", label: "Sync" },
	{ id: "multicam", label: "Multicam" },
	{ id: "sequence", label: "Export" },
];
const CHANNEL_COLORS = ["#6366f1", "#f59e0b", "#22c55e", "#ef4444", "#8b5cf6"];

function displayBaseName(name: string): string {
	return name.replace(/\.[^.]+$/, "");
}

type SourceSuggestions = ReturnType<
	import("@/core/managers/commands").CommandManager["suggestPodcastSources"]
>["suggestions"];

function buildInitialDrafts({
	videoAssets,
	suggestions,
	count,
}: {
	videoAssets: MediaAsset[];
	suggestions: SourceSuggestions;
	count: number;
}): ChannelDraft[] {
	return Array.from({ length: count }, (_, index) => {
		const video = videoAssets[index];
		return {
			id: `channel-${index + 1}`,
			name: video ? displayBaseName(video.name) : `Channel ${index + 1}`,
			videoAssetId: video?.id ?? NONE_VALUE,
			audioAssetId:
				suggestions.find((s) => s.videoId === video?.id)?.audioId ?? NONE_VALUE,
			audioExplicit: false,
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
	const [linkedIds, setLinkedIds] = useState<string[]>([]);
	const [sourcePaths, setSourcePaths] = useState("");
	const [isImporting, setIsImporting] = useState(false);
	type AngleDraft = { cameraIds: string[]; preferredCameraId: string };
	const [angleOverrides, setAngleOverrides] = useState<AngleDraft[] | null>(
		null,
	);
	const videoAssets = useMemo(() => {
		const grouped = new Set(
			assets.flatMap((asset) => asset.unifiedAngles?.angleAssetIds ?? []),
		);
		const selected = [
			...assets,
			...editor.media.getAssets().filter((a) => linkedIds.includes(a.id)),
		];
		return [
			...new Map(
				selected
					.filter((a) => a.type === "video" && !grouped.has(a.id))
					.map((a) => [a.id, a]),
			).values(),
		];
	}, [assets, editor, linkedIds]);
	const audioAssets = useMemo(
		() =>
			editor.media
				.getAssets()
				.filter(
					(asset) =>
						asset.type === "audio" ||
						(asset.type === "video" && asset.hasAudio),
				),
		[assets, editor, linkedIds],
	);
	const sourceSuggestions = useMemo(
		() =>
			videoAssets.length
				? editor.command.suggestPodcastSources(
						videoAssets.slice(0, MAX_CHANNELS).map((a) => a.id),
					)
				: { hasExternalAudio: false, suggestions: [] },
		[editor, videoAssets],
	);
	const [recordingSelection, setRecordingSelection] = useState<string[] | null>(
		null,
	);
	const recordingIds =
		recordingSelection ??
		audioAssets.filter((a) => a.type === "audio").map((a) => a.id);
	const recordingGroups = useMemo(() => {
		const ids =
			recordingSelection ??
			audioAssets.filter((a) => a.type === "audio").map((a) => a.id);
		if (!ids.length)
			return {
				microphones: [],
				issues: ["Import microphone WAV recordings into Assets"],
			};
		try {
			return editor.command.groupPodcastRecordings(ids);
		} catch (error) {
			return {
				microphones: [],
				issues: [
					error instanceof Error
						? error.message
						: "Cannot group microphone recordings",
				],
			};
		}
	}, [editor, audioAssets, recordingSelection]);
	const cameraSuggestions = useMemo(() => {
		const videoIds = videoAssets
			.filter((a) => !a.unifiedAngles)
			.map((a) => a.id);
		if (!videoIds.length) return { groups: [], issues: [] };
		try {
			return editor.command.suggestPodcastCameras({ videoIds, recordingIds });
		} catch (error) {
			return {
				groups: [],
				issues: [
					error instanceof Error
						? error.message
						: "Cannot suggest camera groups",
				],
			};
		}
	}, [editor, videoAssets, recordingIds]);
	const angleDrafts =
		angleOverrides ??
		cameraSuggestions.groups
			.filter((g) => g.cameraIds.length > 1)
			.map((g) => ({
				cameraIds: g.cameraIds,
				preferredCameraId: g.preferredCameraId,
			}));
	const suggestions = sourceSuggestions.suggestions;
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
		buildInitialDrafts({ videoAssets, suggestions, count: initialCount }),
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
	const analysisAbort = useRef<AbortController | null>(null);
	const analysisProject = useRef<string | null>(null);
	useEffect(() => () => analysisAbort.current?.abort(), []);

	const assetById = new Map(
		editor.media.getAssets().map((asset) => [asset.id, asset]),
	);
	const currentStepIndex = STEPS.findIndex((item) => item.id === step);

	const applySourceSuggestions = ({
		videos = videoAssets,
		recordings = recordingIds,
	}: { videos?: MediaAsset[]; recordings?: string[] } = {}) => {
		const suggested = editor.command.suggestPodcastCameras({
			videoIds: videos.filter((a) => !a.unifiedAngles).map((a) => a.id),
			recordingIds: recordings,
		});
		setChannels(
			buildInitialDrafts({
				videoAssets: videos,
				suggestions: [],
				count: Math.max(1, videos.length),
			}).map((c) => ({
				...c,
				microphoneIds:
					suggested.groups.find((g) => g.cameraIds.includes(c.videoAssetId))
						?.microphoneIds ?? [],
			})),
		);
		setAngleOverrides(
			suggested.groups
				.filter((g) => g.cameraIds.length > 1)
				.map((g) => ({
					cameraIds: g.cameraIds,
					preferredCameraId: g.preferredCameraId,
				})),
		);
		setAlignment(null);
		setResult(null);
		setSequenceCreated(false);
	};
	const importLinkedSources = async () => {
		if (!activeProject) return;
		const projectId = activeProject.metadata.id;
		const paths = sourcePaths
			.split(/\r?\n/)
			.map((p) => p.trim().replace(/^['"]|['"]$/g, ""))
			.filter(Boolean);
		if (!paths.length) return;
		setIsImporting(true);
		try {
			const records = await registerLocalMediaPaths({
				projectId,
				paths,
				preserveLink: true,
			});
			const processed = await processLocalDriveMedia({ projectId, records });
			const added: string[] = [];
			for (const asset of processed) {
				const result = await editor.media.addMediaAsset({ projectId, asset });
				if (!result) throw new Error(`Could not register ${asset.name}`);
				added.push(result.id);
			}
			if (editor.project.getActiveOrNull()?.metadata.id !== projectId)
				throw new Error("Project changed during import");
			const ids = [...linkedIds, ...added];
			setLinkedIds(ids);
			setSourcePaths("");
			const all = editor.media.getAssets();
			const videos = all.filter(
				(a) =>
					a.type === "video" &&
					[...assets.map((a) => a.id), ...ids].includes(a.id),
			);
			const recordings = all.filter((a) => a.type === "audio").map((a) => a.id);
			setRecordingSelection(recordings);
			if (videos.length) {
				setMode("advanced");
				applySourceSuggestions({ videos, recordings });
			}
			await editor.save.flush();
			toast.success("Linked sources added without copying recording files");
		} catch (error) {
			toast.error("Source import failed", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setIsImporting(false);
		}
	};
	const setChannelCount = (nextCount: number) => {
		setAlignment(null);
		setResult(null);
		setSequenceCreated(false);
		const count = Math.max(1, Math.min(MAX_CHANNELS, Math.floor(nextCount)));
		setChannels((current) => {
			if (count <= current.length) return current.slice(0, count);
			const allDrafts = buildInitialDrafts({
				videoAssets,
				suggestions,
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
		if (patch.videoAssetId !== undefined) {
			patch = {
				...patch,
				audioAssetId:
					suggestions.find((s) => s.videoId === patch.videoAssetId)?.audioId ??
					NONE_VALUE,
				audioExplicit: false,
			};
		} else if (patch.audioAssetId !== undefined) {
			patch = { ...patch, audioExplicit: true };
		}
		setAlignment(null);
		setResult(null);
		setSequenceCreated(false);
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
		const assetById = new Map(
			editor.media.getAssets().map((asset) => [asset.id, asset]),
		);
		if (
			mode === "advanced" &&
			(recordingGroups.issues.length ||
				channels.some((c) => !c.microphoneIds?.length) ||
				recordingGroups.microphones.some(
					(m) => !channels.some((c) => c.microphoneIds?.includes(m.id)),
				))
		) {
			toast.error(
				recordingGroups.issues[0] ??
					"Assign every microphone to at least one camera, and microphones to every camera",
			);
			return null;
		}
		if (
			mode === "advanced" &&
			angleDrafts.some((g) =>
				g.cameraIds.some((id) => !channels.some((c) => c.videoAssetId === id)),
			)
		) {
			toast.error(
				"Select every camera in the multi angle group, or remove that group",
			);
			return null;
		}
		const resolved: PodcastSyncChannel[] = [];
		const usedVideoIds = new Set<string>();
		const usedAudioIds = new Set<string>();
		for (const draft of channels) {
			const video = assetById.get(draft.videoAssetId);
			const selectedMic =
				mode === "advanced"
					? recordingGroups.microphones.find((m) =>
							draft.microphoneIds?.includes(m.id),
						)
					: undefined;
			const audio = assetById.get(
				selectedMic?.segments[0]?.recording.mediaId ?? draft.audioAssetId,
			);
			if (!video || video.type !== "video") {
				toast.error(`${draft.name} needs a camera video`);
				return null;
			}
			if (!audio || (audio.type !== "audio" && audio.type !== "video")) {
				toast.error(`${draft.name} needs a microphone source`);
				return null;
			}
			if (
				audio.type === "video" &&
				editor.media.getAssets().some((a) => a.type === "audio") &&
				!draft.audioExplicit
			) {
				toast.error(
					`${draft.name}: choose the external microphone, or explicitly select camera audio`,
				);
				return null;
			}
			if (usedVideoIds.has(video.id)) {
				toast.error(`${video.name} is used by more than one channel`);
				return null;
			}
			if (mode !== "advanced" && usedAudioIds.has(audio.id)) {
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
		try {
			return resolvePodcastChannelSources({
				channels: resolved,
				mediaAssets: editor.media.getAssets(),
			});
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Missing camera source",
			);
			return null;
		}
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
		analysisAbort.current?.signal.throwIfAborted();
		if (
			editor.project.getActiveOrNull()?.metadata.id !== analysisProject.current
		)
			throw new Error("The active project changed. Run synchronization again.");
		for (const [id, revision] of Object.entries(resolvedResult.bindings)) {
			if (
				!editor.media
					.getAssets()
					.some(
						(a) =>
							a.id === id &&
							!a.missing &&
							(a.bindingRevision ?? 0) === revision,
					)
			)
				throw new Error("Media changed. Run synchronization again.");
		}
		editor.command.createMulticam({
			plan: {
				settings: resolvedSettings,
				advanced: resolvedResult.advanced,
				channels: resolvedChannels.map((channel) => ({
					id: channel.id,
					name: channel.name,
					videoId: channel.video.id,
					audioId: channel.audio.id,
					videoBindingRevision: channel.video.bindingRevision ?? 0,
					audioBindingRevision: channel.audio.bindingRevision ?? 0,
					videoOffset: resolvedResult.videoOffsets[channel.id] ?? 0,
					videoDelay: resolvedResult.videoDelays[channel.id] ?? 0,
					audioOffset: resolvedResult.audioOffsets[channel.id] ?? 0,
					audioDelay: resolvedResult.audioDelays[channel.id] ?? 0,
				})),
				duration: resolvedResult.duration,
				cuts: resolvedResult.cuts,
			},
			allowCameraAudio: resolvedChannels.some((c) => c.audio.type === "video"),
		});
		await editor.save.flush();
		setSequenceCreated(true);
	};

	const handleRunAlignment = async () => {
		const resolvedChannels = resolveChannels();
		if (!resolvedChannels) return null;
		const resolvedSettings = normalizedSettings(mode !== "guided");
		setSettings(resolvedSettings);
		setIsRunning(true);
		setProgress({ step: "Starting synchronization", value: 0 });
		analysisAbort.current?.abort();
		analysisAbort.current = new AbortController();
		analysisProject.current = activeProject?.metadata.id ?? null;
		try {
			const nextAlignment = await runPodcastAlignment({
				advanced:
					mode === "advanced"
						? {
								microphones: recordingGroups.microphones,
								routing: {
									microphoneIds: recordingGroups.microphones.map((m) => m.id),
									angleGroups: angleDrafts.map((g, i) => ({
										id: `angles-${i + 1}`,
										channelIds: g.cameraIds.map(
											(id) => channels.find((c) => c.videoAssetId === id)!.id,
										),
										preferredChannelId: channels.find(
											(c) => c.videoAssetId === g.preferredCameraId,
										)!.id,
									})),
									cameras: channels.map((c) => ({
										channelId: c.id,
										microphoneIds: c.microphoneIds ?? [],
									})),
								},
								assets: editor.media.getAssets(),
							}
						: undefined,
				channels: resolvedChannels,
				settings: resolvedSettings,
				signal: analysisAbort.current.signal,
				onProgress: ({ step: nextStep, progress: value }) =>
					setProgress({ step: nextStep, value }),
			});
			analysisAbort.current.signal.throwIfAborted();
			if (
				editor.project.getActiveOrNull()?.metadata.id !==
				analysisProject.current
			)
				throw new Error("The project changed during synchronization");
			if (nextAlignment.unifiedSync.length)
				editor.command.syncUnifiedAngles(nextAlignment.unifiedSync);
			for (const update of nextAlignment.unifiedSync)
				nextAlignment.bindings[update.mediaId] =
					editor.media.getAssets().find((a) => a.id === update.mediaId)
						?.bindingRevision ?? 0;
			await editor.save.flush();
			setAlignment(nextAlignment);
			for (const warning of nextAlignment.precisionWarnings ?? [])
				toast.warning(warning, { duration: 12000 });
			return { resolvedChannels, resolvedSettings, nextAlignment };
		} catch (error) {
			if (analysisAbort.current?.signal.aborted) return null;
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
		for (const [id, revision] of Object.entries(resolvedAlignment.bindings)) {
			if (
				!editor.media
					.getAssets()
					.some(
						(a) =>
							a.id === id &&
							!a.missing &&
							(a.bindingRevision ?? 0) === revision,
					)
			) {
				toast.error("Media changed. Run synchronization again.");
				return null;
			}
		}
		const resolvedSettings = normalizedSettings(quick);
		setSettings(resolvedSettings);
		setIsRunning(true);
		setProgress({ step: "Starting multicam analysis", value: 0 });
		analysisAbort.current?.abort();
		analysisAbort.current = new AbortController();
		try {
			const nextResult = await runPodcastMulticam({
				channels: resolvedChannels,
				settings: resolvedSettings,
				alignment: resolvedAlignment,
				signal: analysisAbort.current.signal,
				onProgress: ({ step: nextStep, progress: value }) =>
					setProgress({ step: nextStep, value }),
			});
			setResult(nextResult);
			return { resolvedChannels, resolvedSettings, nextResult };
		} catch (error) {
			if (analysisAbort.current?.signal.aborted) return null;
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
		if (!syncRun || analysisAbort.current?.signal.aborted) return;
		setStep("multicam");
		const multicamRun = await handleRunMulticam({
			alignmentOverride: syncRun.nextAlignment,
			quick: true,
		});
		if (!multicamRun || analysisAbort.current?.signal.aborted) return;
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
			onOpenChange={(next) => !isRunning && !isImporting && onOpenChange(next)}
		>
			<DialogContent className="max-h-[92vh] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
				<DialogHeader>
					<DialogTitle>Podcast Multicam</DialogTitle>
					<DialogDescription>
						Sync all cameras and microphones together, detect the active
						speaker, then apply microphone gain, limiting, noise reduction and
						Sharpen automatically.
					</DialogDescription>
					<WizardSteps currentIndex={currentStepIndex} />
				</DialogHeader>

				<DialogBody className="min-h-0 overflow-y-auto">
					{step === "media" ? <PodcastFinishPanel /> : null}
					{step === "media" ? (
						<details className="mb-4 rounded-lg border p-3">
							<summary className="cursor-pointer text-sm font-medium">
								Add linked camera / microphone paths
							</summary>
							<p className="my-2 text-xs text-muted-foreground">
								One absolute file path per line. Recordings stay on their
								original disk or memory card.
							</p>
							<Textarea
								aria-label="Linked source paths"
								value={sourcePaths}
								onChange={(e) => setSourcePaths(e.target.value)}
								disabled={isImporting}
							/>
							<Button
								className="mt-2"
								variant="outline"
								disabled={isImporting || !sourcePaths.trim()}
								onClick={() => void importLinkedSources()}
							>
								{isImporting
									? "Linking sources…"
									: "Link sources without copying"}
							</Button>
						</details>
					) : null}
					{step === "media" ? (
						<MediaStep
							mode={mode}
							onModeChange={(next) => {
								if (
									next === "advanced" &&
									videoAssets.length &&
									channels.every((c) => !c.microphoneIds?.length)
								)
									applySourceSuggestions();
								setMode(next);
								setAlignment(null);
								setResult(null);
								setSequenceCreated(false);
							}}
							channels={channels}
							settings={settings}
							videoAssets={videoAssets}
							audioAssets={audioAssets}
							suggestions={suggestions}
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
					{step === "media" && mode === "advanced" ? (
						<PodcastAngleFields
							videos={videoAssets.filter((a) => !a.unifiedAngles)}
							groups={angleDrafts}
							suggestions={cameraSuggestions.groups}
							onSuggest={() => applySourceSuggestions()}
							onChange={(groups) => {
								setAngleOverrides(groups);
								setAlignment(null);
								setResult(null);
								setSequenceCreated(false);
							}}
						/>
					) : null}
					{step === "media" && mode === "advanced" ? (
						<AdvancedMicrophoneFields
							assets={audioAssets}
							selected={recordingIds}
							groups={recordingGroups}
							channels={channels}
							onSelection={(ids) => {
								setRecordingSelection(ids);
								setAlignment(null);
								setResult(null);
								setSequenceCreated(false);
							}}
							onMapping={({ id, microphoneIds }) =>
								updateChannel({ channelId: id, patch: { microphoneIds } })
							}
						/>
					) : null}
					{step === "sync" ? (
						<SyncStep
							microphones={
								mode === "advanced" ? recordingGroups.microphones : undefined
							}
							channels={channels}
							assetById={assetById}
							alignment={alignment}
							isRunning={isRunning}
							progress={progress}
							auto={mode !== "guided"}
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
							auto={mode !== "guided"}
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
					{isRunning ? (
						<Button
							variant="outline"
							onClick={() => {
								analysisAbort.current?.abort();
								setStep("media");
								setAlignment(null);
								setResult(null);
							}}
						>
							Cancel analysis
						</Button>
					) : null}
					{step === "media" ? (
						<>
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button
								onClick={() => {
									if (!resolveChannels()) return;
									if (mode !== "guided") void handleAutoEdit();
									else setStep("sync");
								}}
							>
								{mode !== "guided" ? (
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
								<Button
									disabled={isRunning}
									onClick={() => setStep("multicam")}
								>
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
								<Button
									disabled={isRunning}
									onClick={() => setStep("sequence")}
								>
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
	suggestions,
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
	suggestions: SourceSuggestions;
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

			<div className="grid gap-3 md:grid-cols-3">
				<ModeCard
					selected={mode === "quick"}
					icon={<WandSparkles className="size-5" />}
					title="Quick Auto Edit"
					description="One click syncs the cameras and microphones, mutes camera audio, and cuts between speakers with 1–20 second shots."
					onClick={() => onModeChange("quick")}
				/>
				<ModeCard
					selected={mode === "advanced"}
					icon={<Mic2 className="size-5" />}
					title="Advanced Podcast"
					description="Join segmented wireless mics, sync different start times and route up to four microphones to shared cameras automatically."
					onClick={() => onModeChange("advanced")}
				/>
				<ModeCard
					selected={mode === "guided"}
					icon={<SlidersHorizontal className="size-5" />}
					title="Step by Step"
					description="Review synchronization and camera cuts, then finish with the podcast audio and Sharpen preset."
					onClick={() => onModeChange("guided")}
				/>
			</div>

			<div className="space-y-3">
				<div>
					<h3 className="text-sm font-medium">Channel media</h3>
					<p className="text-muted-foreground text-xs">
						{mode === "advanced"
							? "Choose cameras, then assign their wireless microphones below."
							: "Choose one camera video and its professional microphone for every channel."}
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
						<div className={cn("space-y-1.5", mode === "advanced" && "hidden")}>
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
									{[...audioAssets]
										.sort((a, b) => {
											const candidates =
												suggestions.find(
													(s) => s.videoId === channel.videoAssetId,
												)?.candidates ?? [];
											return (
												(candidates.find((c) => c.audioId === b.id)?.score ??
													-1) -
												(candidates.find((c) => c.audioId === a.id)?.score ??
													-1)
											);
										})
										.map((asset) => (
											<SelectItem key={asset.id} value={asset.id}>
												{asset.name}
												{asset.type === "video" ? " (camera audio)" : ""}
											</SelectItem>
										))}
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">
								{suggestions
									.find((s) => s.videoId === channel.videoAssetId)
									?.candidates.find((c) => c.audioId === channel.audioAssetId)
									?.reason ??
									(channel.audioAssetId === NONE_VALUE
										? "Choose a microphone; no unique name match"
										: "Camera audio selected")}
							</p>
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
	microphones,
	channels,
	assetById,
	alignment,
	isRunning,
	progress,
	auto,
	onRun,
}: {
	channels: ChannelDraft[];
	microphones?: import("opencut-wasm").PodcastMicrophone[];
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
					All camera and microphone recordings are analyzed together and aligned
					to one shared timeline.
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
							{microphones
								? microphones
										.filter((m) => channel.microphoneIds?.includes(m.id))
										.map((m) => m.name)
										.join(", ")
								: assetById.get(channel.audioAssetId)?.name}
						</span>
					</div>
				))}
			</div>
			{alignment ? (
				<div className="space-y-2">
					<h4 className="text-sm font-medium">Sync results</h4>
					{alignment.advanced ? (
						<div className="space-y-1 rounded border p-3">
							{alignment.advanced.microphones.map((m) => {
								const start = alignment.advanced!.starts[m.id]!;
								return (
									<div
										key={m.id}
										className="flex justify-between gap-3 text-xs"
									>
										<span>
											{m.name} · {m.segments.length} clips
										</span>
										<span>
											{start >= 0
												? `Starts at ${start.toFixed(3)}s`
												: `Trim ${(-start).toFixed(3)}s`}
										</span>
									</div>
								);
							})}
						</div>
					) : null}
					{alignment.precisionWarnings?.map((warning) => (
						<p key={warning} role="status" className="text-sm text-amber-600">
							{warning}
						</p>
					))}
					<div className="overflow-hidden rounded-lg border">
						<div className="grid grid-cols-3 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
							<span>Channel</span>
							<span>Video trim</span>
							<span>
								{alignment.advanced
									? "Assigned microphones"
									: "Audio trim / delay"}
							</span>
						</div>
						{channels.map((channel) => (
							<div
								key={channel.id}
								className="grid grid-cols-3 border-t px-3 py-2 text-sm"
							>
								<span>{channel.name}</span>
								<span>
									{(alignment.videoDelays[channel.id] ?? 0) > 0
										? `Starts at ${alignment.videoDelays[channel.id].toFixed(2)}s`
										: `Trim ${(alignment.videoOffsets[channel.id] ?? 0).toFixed(2)}s`}
								</span>
								<span>
									{alignment.advanced
										? alignment.advanced.microphones
												.filter((m) => channel.microphoneIds?.includes(m.id))
												.map((m) => m.name)
												.join(", ")
										: `${(alignment.audioOffsets[channel.id] ?? 0).toFixed(2)}s / ${(alignment.audioDelays[channel.id] ?? 0).toFixed(2)}s`}
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
						label="Max shot (seconds, 0 = off)"
						value={settings.maxCutDuration}
						min={0}
						max={3600}
						step={1}
						disabled={isRunning || !!result}
						onChange={(maxCutDuration) =>
							onSettingsChange({ ...settings, maxCutDuration })
						}
					/>
					<NumberSetting
						label="Reaction shot (seconds)"
						value={settings.reactionDuration ?? 5}
						min={settings.minCutDuration}
						max={60}
						step={0.1}
						disabled={isRunning || !!result || settings.maxCutDuration === 0}
						onChange={(reactionDuration) =>
							onSettingsChange({ ...settings, reactionDuration })
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
								CHANNEL_COLORS[
									(channelIndex.get(cut.channelId) ?? 0) % CHANNEL_COLORS.length
								],
						}}
					/>
				))}
			</div>
			<div className="flex flex-wrap gap-3">
				{channels.map((channel, index) => (
					<div key={channel.id} className="flex items-center gap-1.5 text-xs">
						<span
							className="size-2.5 rounded-sm"
							style={{
								backgroundColor: CHANNEL_COLORS[index % CHANNEL_COLORS.length],
							}}
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
					? `“${sequenceName}” is ready: synchronized cameras with enabled/disabled cuts, muted camera sound, microphone Volume +15 dB, Gain −1 dB, Hard Limiter −1 dB, noise reduction 100% and Sharpen 15%.`
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

function AdvancedMicrophoneFields({
	assets,
	selected,
	groups,
	channels,
	onSelection,
	onMapping,
}: {
	assets: MediaAsset[];
	selected: string[];
	groups: import("opencut-wasm").PodcastRecordingGroups;
	channels: ChannelDraft[];
	onSelection: (ids: string[]) => void;
	onMapping: (mapping: { id: string; microphoneIds: string[] }) => void;
}) {
	return (
		<div className="space-y-4 mt-4 rounded-lg border p-4">
			<h3 className="font-medium">Wireless microphone recordings</h3>
			<p className="text-muted-foreground text-xs">
				Select this session&apos;s WAV files. Recorder tokens keep the segments
				separate. Each stream is synchronized from its own start.
			</p>
			<div className="space-y-1 max-h-40 overflow-auto">
				{assets
					.filter((a) => a.type === "audio")
					.map((a) => (
						<label key={a.id} className="flex items-center gap-2 text-xs">
							<input
								type="checkbox"
								checked={selected.includes(a.id)}
								onChange={(e) =>
									onSelection(
										e.target.checked
											? [...selected, a.id]
											: selected.filter((id) => id !== a.id),
									)
								}
							/>
							{a.name}
						</label>
					))}
			</div>
			{groups.microphones.map((m) => (
				<div key={m.id} className="rounded border p-2 text-xs">
					<strong>{m.name}</strong> · {m.segments.length} clips ·{" "}
					{(m.duration / 60).toFixed(2)} min
					<div className="text-muted-foreground break-all">
						{m.segments.map((s) => s.recording.name).join(" → ")}
					</div>
				</div>
			))}
			{groups.issues.map((issue, i) => (
				<p key={i} role="alert" className="text-destructive text-xs">
					{issue}
				</p>
			))}
			<h4 className="text-sm font-medium">
				Microphones visible in each camera
			</h4>
			{channels.map((c) => (
				<div key={c.id} className="space-y-1">
					<Label>{c.name}</Label>
					<div className="flex flex-wrap gap-4">
						{groups.microphones.map((m) => (
							<label key={m.id} className="flex items-center gap-2 text-xs">
								<input
									type="checkbox"
									checked={c.microphoneIds?.includes(m.id) ?? false}
									onChange={(e) =>
										onMapping({
											id: c.id,
											microphoneIds: e.target.checked
												? [...(c.microphoneIds ?? []), m.id]
												: (c.microphoneIds ?? []).filter((id) => id !== m.id),
										})
									}
								/>
								{m.name}
							</label>
						))}
					</div>
				</div>
			))}
		</div>
	);
}

function PodcastAngleFields({
	videos,
	groups,
	suggestions,
	onSuggest,
	onChange,
}: {
	videos: MediaAsset[];
	groups: Array<{ cameraIds: string[]; preferredCameraId: string }>;
	suggestions: import("opencut-wasm").PodcastCameraSuggestion[];
	onSuggest: () => void;
	onChange: (
		groups: Array<{ cameraIds: string[]; preferredCameraId: string }>,
	) => void;
}) {
	const [selected, setSelected] = useState<string[]>([]);
	const [preferred, setPreferred] = useState("");
	return (
		<div className="mt-4 space-y-3 rounded-lg border p-4">
			<div className="flex items-center justify-between gap-3">
				<h3 className="font-medium">Multi angle cameras</h3>
				<Button variant="outline" size="sm" onClick={onSuggest}>
					Use camera and mic suggestions
				</Button>
			</div>
			<p className="text-muted-foreground text-xs">
				Related camera names suggest an angle group. Main is preferred; the
				alternate provides a brief change after long 15–20 second shots. No
				Assets merge needed.
			</p>
			{groups.map((g, i) => (
				<div
					key={g.cameraIds.join(":")}
					className="space-y-2 rounded border p-3"
				>
					<div className="flex justify-between text-xs">
						<span>
							{g.cameraIds
								.map((id) => videos.find((a) => a.id === id)?.name ?? id)
								.join(" + ")}
						</span>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => onChange(groups.filter((_, j) => j !== i))}
						>
							Ungroup
						</Button>
					</div>
					<p className="text-muted-foreground text-xs">
						{suggestions.find((s) =>
							s.cameraIds.every((id) => g.cameraIds.includes(id)),
						)?.evidence ?? "Custom angle group"}
					</p>
					<Label>Preferred main camera</Label>
					<Select
						value={g.preferredCameraId}
						onValueChange={(id) =>
							onChange(
								groups.map((old, j) =>
									j === i ? { ...old, preferredCameraId: id } : old,
								),
							)
						}
					>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{g.cameraIds.map((id) => (
								<SelectItem key={id} value={id}>
									{videos.find((a) => a.id === id)?.name ?? id}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			))}
			<details>
				<summary className="cursor-pointer text-xs">
					Choose a custom multi angle group
				</summary>
				<div className="my-2 space-y-1">
					{videos.map((a) => (
						<label key={a.id} className="flex gap-2 text-xs">
							<input
								type="checkbox"
								checked={selected.includes(a.id)}
								onChange={(e) =>
									setSelected(
										e.target.checked
											? [...selected, a.id]
											: selected.filter((id) => id !== a.id),
									)
								}
							/>
							{a.name}
						</label>
					))}
				</div>
				<Select
					value={
						selected.includes(preferred) ? preferred : (selected[0] ?? "none")
					}
					onValueChange={setPreferred}
				>
					<SelectTrigger>
						<SelectValue placeholder="Main camera" />
					</SelectTrigger>
					<SelectContent>
						{selected.length ? (
							selected.map((id) => (
								<SelectItem key={id} value={id}>
									{videos.find((a) => a.id === id)?.name ?? id}
								</SelectItem>
							))
						) : (
							<SelectItem value="none">Choose cameras first</SelectItem>
						)}
					</SelectContent>
				</Select>
				<Button
					className="mt-2"
					variant="outline"
					size="sm"
					disabled={selected.length < 2}
					onClick={() => {
						onChange([
							...groups.filter(
								(g) => !g.cameraIds.some((id) => selected.includes(id)),
							),
							{
								cameraIds: selected,
								preferredCameraId: selected.includes(preferred)
									? preferred
									: selected[0]!,
							},
						]);
						setSelected([]);
					}}
				>
					Add multi angle group
				</Button>
			</details>
		</div>
	);
}
