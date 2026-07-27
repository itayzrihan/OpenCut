import { Button } from "@/components/ui/button";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useEffect, useReducer, useRef, useState } from "react";
import {
	useEditor,
	useEditorDiagnostics,
	useEditorProject,
	useEditorTimelineScenes,
	useEditorTranscription,
} from "@/editor/use-editor";
import { sharedLibraryService } from "@/shared-library/service";
import type { SharedCaptionPreset } from "@/shared-library/types";
import { TRANSCRIPTION_DIAGNOSTICS_SCOPE } from "@/transcription/diagnostics";
import { TRANSCRIPTION_LANGUAGES } from "@/transcription/supported-languages";
import type {
	CaptionChunk,
	TranscriptionLanguage,
} from "@/transcription/types";
import {
	DEFAULT_CAPTION_LAYOUT,
	getCaptionGridCell,
	getCaptionPlacementGrid,
	normalizeCaptionLayoutSettings,
	type CaptionLayoutSettings,
} from "@/subtitles/caption-layout";
import { insertCaptionChunksAsTextTrack } from "@/subtitles/insert";
import {
	findCaptionSourceTrack,
	rebuildCaptionTracksWithSource,
} from "@/subtitles/caption-tracks";
import { parseSubtitleFile } from "@/subtitles/parse";
import { Spinner } from "@/components/ui/spinner";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
} from "@/components/section";
import { AlertCircleIcon, CloudUploadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { DiagnosticSeverity } from "@/diagnostics/types";
import { TracksSnapshotCommand } from "@/commands";
import type { TextCaptionRevealMode, TextWordTransitionIn } from "@/timeline";
import {
	CAPTION_ACCENT_COLORS,
	CAPTION_WORD_ANIMATIONS,
} from "@/text/caption-presets";
import { toast } from "sonner";

const DIAGNOSTIC_BUTTON_VARIANT: Record<
	DiagnosticSeverity,
	"caution" | "destructive-foreground"
> = {
	caution: "caution",
	error: "destructive-foreground",
};

type ProcessingState =
	| { status: "idle"; error: string | null; warnings: string[] }
	| { status: "processing"; step: string };

type ProcessingAction =
	| { type: "start"; step: string }
	| { type: "update_step"; step: string }
	| { type: "succeed"; warnings: string[] }
	| { type: "fail"; error: string };

const IDLE_STATE: ProcessingState = {
	status: "idle",
	error: null,
	warnings: [],
};

const CAPTION_LAYER_COUNT = 2;
const CAPTION_LAST_SETTINGS_STORAGE_KEY = "opencut.caption.lastSettings";
const CAPTION_SAVED_PRESETS_STORAGE_KEY = "opencut.caption.savedPresets";

type SavedCaptionPreset = SharedCaptionPreset;
const CAPTION_REVEAL_MODES: Array<{
	value: TextCaptionRevealMode;
	label: string;
}> = [
	{ value: "determined-by-preset", label: "Determined by preset" },
	{ value: "row", label: "Whole row together" },
	{ value: "spoken-word", label: "Show word when spoken" },
	{ value: "spoken-word-keep", label: "Show word and keep previous" },
	{ value: "emphasize-spoken", label: "Emphasize spoken word" },
	{ value: "emphasize-spoken-keep", label: "Keep words emphasized" },
	{ value: "letter-by-letter", label: "Letter by letter typing" },
	{ value: "growing-row", label: "Growing row" },
];
const CAPTION_TRANSITION_IN_OPTIONS: Array<{
	value: TextWordTransitionIn;
	label: string;
}> = [
	{ value: "none", label: "None" },
	{ value: "fade", label: "Fade" },
	{ value: "blur", label: "Blur build" },
	{ value: "zoom", label: "Zoom" },
	{ value: "blur-zoom", label: "Blur zoom" },
	{ value: "rise", label: "Rise" },
	{ value: "slide", label: "Slide" },
	{ value: "typewriter", label: "Type letter by letter" },
	{ value: "glow-dissolve", label: "Glow blur dissolve" },
];

function usesTransitionIn(revealMode: TextCaptionRevealMode): boolean {
	return revealMode === "spoken-word" || revealMode === "spoken-word-keep";
}

/* eslint-disable opencut/prefer-object-params -- React reducers must accept (state, action). */
function processingReducer(
	state: ProcessingState,
	action: ProcessingAction,
): ProcessingState {
	switch (action.type) {
		case "start":
			return { status: "processing", step: action.step };
		case "update_step":
			if (state.status !== "processing") return state;
			return { status: "processing", step: action.step };
		case "succeed":
			return { status: "idle", error: null, warnings: action.warnings };
		case "fail":
			return { status: "idle", error: action.error, warnings: [] };
	}
}
/* eslint-enable opencut/prefer-object-params */

function loadLastCaptionSettings(): CaptionLayoutSettings {
	if (typeof window === "undefined") {
		return { ...DEFAULT_CAPTION_LAYOUT };
	}
	try {
		const raw = window.localStorage.getItem(CAPTION_LAST_SETTINGS_STORAGE_KEY);
		if (!raw) return { ...DEFAULT_CAPTION_LAYOUT };
		return normalizeCaptionLayoutSettings({ settings: JSON.parse(raw) });
	} catch {
		return { ...DEFAULT_CAPTION_LAYOUT };
	}
}

function saveLastCaptionSettings({
	settings,
}: {
	settings: CaptionLayoutSettings;
}) {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(
		CAPTION_LAST_SETTINGS_STORAGE_KEY,
		JSON.stringify(settings),
	);
}

function loadLegacySavedCaptionPresets(): SavedCaptionPreset[] {
	if (typeof window === "undefined") return [];
	const timestamp = new Date().toISOString();
	try {
		const raw = window.localStorage.getItem(CAPTION_SAVED_PRESETS_STORAGE_KEY);
		const parsed = raw ? JSON.parse(raw) : [];
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(item) =>
					item &&
					typeof item.id === "string" &&
					typeof item.name === "string" &&
					item.settings,
			)
			.map((item) => ({
				id: item.id,
				name: item.name,
				settings: normalizeCaptionLayoutSettings({ settings: item.settings }),
				createdAt:
					typeof item.createdAt === "string" ? item.createdAt : timestamp,
				updatedAt:
					typeof item.updatedAt === "string" ? item.updatedAt : timestamp,
			}));
	} catch {
		return [];
	}
}

function clearLegacySavedCaptionPresets() {
	if (typeof window === "undefined") return;
	window.localStorage.removeItem(CAPTION_SAVED_PRESETS_STORAGE_KEY);
}

function mergeCaptionPresets({
	repositoryPresets,
	localPresets,
}: {
	repositoryPresets: SavedCaptionPreset[];
	localPresets: SavedCaptionPreset[];
}): SavedCaptionPreset[] {
	const repositoryIds = new Set(repositoryPresets.map((preset) => preset.id));
	return [
		...repositoryPresets,
		...localPresets.filter((preset) => !repositoryIds.has(preset.id)),
	].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function getErrorMessage({
	error,
	fallback,
}: {
	error: unknown;
	fallback: string;
}): string {
	return error instanceof Error ? error.message : fallback;
}

function getTranscriptionStep({ phase }: { phase?: string }): string {
	switch (phase) {
		case "extracting_audio":
			return "Extracting audio...";
		case "transcribing":
			return "Transcribing locally...";
		case "generating_captions":
			return "Generating captions...";
		case "cancelling":
			return "Cancelling...";
		default:
			return "Processing transcript...";
	}
}

export function Captions() {
	const [selectedLanguage, setSelectedLanguage] =
		useState<TranscriptionLanguage>("he");
	const [captionSettings, setCaptionSettings] = useState<CaptionLayoutSettings>(
		() => loadLastCaptionSettings(),
	);
	const [savedPresets, setSavedPresets] = useState<SavedCaptionPreset[]>([]);
	const [processing, dispatch] = useReducer(processingReducer, IDLE_STATE);
	const containerRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const editor = useEditor();
	const canvasSize = useEditorProject(
		(e) => e.project.getActive().settings.canvasSize,
	);

	const transcriptionState = useEditorTranscription((e) =>
		e.transcription.getState(),
	);
	const isLocalProcessing = processing.status === "processing";
	const isTranscriptionProcessing =
		transcriptionState.task.status === "running" ||
		transcriptionState.task.status === "cancelling";
	const isProcessing = isLocalProcessing || isTranscriptionProcessing;
	const placementGrid = getCaptionPlacementGrid({ canvasSize });
	const selectedGridCell = getCaptionGridCell({
		settings: captionSettings,
		canvasSize,
	});

	const activeDiagnostics = useEditorDiagnostics((e) =>
		e.diagnostics.getActive({ scope: TRANSCRIPTION_DIAGNOSTICS_SCOPE }),
	);
	const hasGeneratedCaptions = useEditorTimelineScenes(
		(e) =>
			e.scenes
				.getActiveSceneOrNull()
				?.tracks.overlay.some(
					(track) => track.type === "text" && !!track.captionSource,
				) ?? false,
	);

	useEffect(() => {
		saveLastCaptionSettings({ settings: captionSettings });
	}, [captionSettings]);

	useEffect(() => {
		let isCancelled = false;

		const loadSharedPresets = async () => {
			const legacyPresets = loadLegacySavedCaptionPresets();

			try {
				let repositoryPresets = await sharedLibraryService.listCaptionPresets();
				const repositoryIds = new Set(
					repositoryPresets.map((preset) => preset.id),
				);
				const presetsToMigrate = legacyPresets.filter(
					(preset) => !repositoryIds.has(preset.id),
				);

				if (presetsToMigrate.length > 0) {
					const migratedPresets: SavedCaptionPreset[] = [];
					for (const preset of presetsToMigrate) {
						migratedPresets.push(
							await sharedLibraryService.upsertCaptionPreset({ preset }),
						);
					}
					repositoryPresets = mergeCaptionPresets({
						repositoryPresets: migratedPresets,
						localPresets: repositoryPresets,
					});
					clearLegacySavedCaptionPresets();
				}
				if (legacyPresets.length > 0 && presetsToMigrate.length === 0) {
					clearLegacySavedCaptionPresets();
				}

				if (!isCancelled) {
					setSavedPresets(
						mergeCaptionPresets({
							repositoryPresets,
							localPresets: legacyPresets,
						}),
					);
				}
			} catch (error) {
				console.error("Failed to load shared caption presets:", error);
				if (!isCancelled) {
					setSavedPresets(legacyPresets);
				}
			}
		};

		void loadSharedPresets();

		return () => {
			isCancelled = true;
		};
	}, []);

	const insertCaptions = ({
		captions,
		captionSource,
	}: {
		captions: CaptionChunk[];
		captionSource?: Parameters<
			typeof insertCaptionChunksAsTextTrack
		>[0]["captionSource"];
	}): boolean => {
		const settings = normalizeCaptionLayoutSettings({
			settings: captionSettings,
		});
		const trackId = insertCaptionChunksAsTextTrack({
			editor,
			captions,
			captionSource: captionSource ? { ...captionSource, settings } : undefined,
			settings,
			layerCount: captionSource ? CAPTION_LAYER_COUNT : 1,
		});
		return trackId.length > 0;
	};

	const updateCaptionSettings = ({
		patch,
	}: {
		patch: Partial<CaptionLayoutSettings>;
	}) => {
		setCaptionSettings((current) =>
			normalizeCaptionLayoutSettings({
				settings: {
					...current,
					...patch,
				},
			}),
		);
	};

	const updateCaptionSetting = ({
		key,
		value,
	}: {
		key: keyof CaptionLayoutSettings;
		value: string;
	}) => {
		setCaptionSettings((current) =>
			normalizeCaptionLayoutSettings({
				settings: {
					...current,
					[key]:
						key === "revealMode" ||
						key === "transitionIn" ||
						key === "wordAnimationId" ||
						key === "accentColor" ||
						key === "wordDirection" ||
						key === "placementMode"
							? value
							: Number(value),
				},
			}),
		);
	};

	const updateCaptionGridCell = ({
		columnIndex,
		rowIndex,
	}: {
		columnIndex: number;
		rowIndex: number;
	}) => {
		updateCaptionSettings({
			patch: {
				placementMode: "grid",
				placementGridX:
					placementGrid.columns <= 1
						? 0
						: columnIndex / (placementGrid.columns - 1),
				placementGridY:
					placementGrid.rows <= 1 ? 0 : rowIndex / (placementGrid.rows - 1),
			},
		});
	};

	const saveCurrentPreset = async () => {
		const name = window.prompt("Preset name");
		const trimmedName = name?.trim();
		if (!trimmedName) return;
		try {
			const nextPreset = await sharedLibraryService.saveCaptionPreset({
				name: trimmedName,
				settings: normalizeCaptionLayoutSettings({ settings: captionSettings }),
			});
			setSavedPresets((current) =>
				mergeCaptionPresets({
					repositoryPresets: [nextPreset],
					localPresets: current,
				}),
			);
			clearLegacySavedCaptionPresets();
			toast.success("Saved caption preset to the shared library");
		} catch (error) {
			const message = getErrorMessage({
				error,
				fallback: "Failed to save caption preset",
			});
			toast.error(message);
			console.error("Failed to save caption preset:", error);
		}
	};

	const loadPreset = ({ presetId }: { presetId: string }) => {
		const preset = savedPresets.find((item) => item.id === presetId);
		if (!preset) return;
		setCaptionSettings(
			normalizeCaptionLayoutSettings({ settings: preset.settings }),
		);
	};

	const renamePreset = async ({ presetId }: { presetId: string }) => {
		const preset = savedPresets.find((item) => item.id === presetId);
		if (!preset) return;
		const nextName = window.prompt("Preset name", preset.name);
		const trimmedName = nextName?.trim();
		if (!trimmedName) return;
		try {
			const updatedPreset = await sharedLibraryService.renameCaptionPreset({
				presetId,
				name: trimmedName,
			});
			if (!updatedPreset) return;
			setSavedPresets((current) =>
				current.map((item) =>
					item.id === presetId ? { ...item, ...updatedPreset } : item,
				),
			);
			clearLegacySavedCaptionPresets();
			toast.success("Renamed caption preset");
		} catch (error) {
			const message = getErrorMessage({
				error,
				fallback: "Failed to rename caption preset",
			});
			toast.error(message);
			console.error("Failed to rename caption preset:", error);
		}
	};

	const applyCaptionSettings = () => {
		const activeScene = editor.scenes.getActiveSceneOrNull();
		if (!activeScene) return;
		const source = findCaptionSourceTrack({
			tracks: activeScene.tracks,
		})?.captionSource;
		if (!source) return;
		const settings = normalizeCaptionLayoutSettings({
			settings: captionSettings,
		});
		const after = rebuildCaptionTracksWithSource({
			tracks: activeScene.tracks,
			words: source.words,
			settings,
			canvasSize: editor.project.getActive().settings.canvasSize,
			layerCount: source.layerCount,
			preserveEditedElements: false,
		});
		if (!after) return;
		editor.command.execute({
			command: new TracksSnapshotCommand({
				before: activeScene.tracks,
				after,
			}),
		});
		setCaptionSettings(settings);
	};

	const handleGenerateTranscript = async () => {
		dispatch({ type: "succeed", warnings: [] });
		await editor.transcription.start({
			language: selectedLanguage,
			settings: captionSettings,
		});
	};

	const handleImportClick = () => {
		fileInputRef.current?.click();
	};

	const handleImportFile = async ({ file }: { file: File }) => {
		dispatch({ type: "start", step: "Reading subtitle file..." });
		try {
			const input = await file.text();
			const result = parseSubtitleFile({
				fileName: file.name,
				input,
			});

			if (result.captions.length === 0) {
				dispatch({
					type: "fail",
					error: "No valid subtitle cues were found in the subtitle file",
				});
				return;
			}

			dispatch({ type: "update_step", step: "Importing subtitles..." });

			if (!insertCaptions({ captions: result.captions })) {
				dispatch({ type: "fail", error: "No captions were generated" });
				return;
			}

			const nextWarnings = [...result.warnings];
			if (result.skippedCueCount > 0) {
				nextWarnings.unshift(
					`Imported ${result.captions.length} subtitle cue(s) and skipped ${result.skippedCueCount} malformed cue(s).`,
				);
			}

			dispatch({ type: "succeed", warnings: nextWarnings });
		} catch (error) {
			console.error("Subtitle import failed:", error);
			dispatch({
				type: "fail",
				error:
					error instanceof Error
						? error.message
						: "An unexpected error occurred",
			});
		}
	};

	const handleFileChange = async ({
		event,
	}: {
		event: React.ChangeEvent<HTMLInputElement>;
	}) => {
		const file = event.target.files?.[0];
		if (event.target) {
			event.target.value = "";
		}
		if (!file) return;

		await handleImportFile({ file });
	};

	const handleLanguageChange = ({ value }: { value: string }) => {
		if (value === "auto") {
			setSelectedLanguage("auto");
			return;
		}

		const matchedLanguage = TRANSCRIPTION_LANGUAGES.find(
			(language) => language.code === value,
		);
		if (!matchedLanguage) return;
		setSelectedLanguage(matchedLanguage.code);
	};

	const error =
		transcriptionState.task.status === "failed"
			? transcriptionState.task.error
			: processing.status === "idle"
				? processing.error
				: null;
	const warnings = processing.status === "idle" ? processing.warnings : [];

	return (
		<PanelView
			title="Captions"
			contentClassName="px-0 flex flex-col h-full"
			actions={
				<TooltipProvider>
					<div className="flex items-center gap-1.5">
						{!isProcessing &&
							activeDiagnostics.map((diagnostic) => (
								<Tooltip key={diagnostic.id}>
									<TooltipTrigger asChild>
										<Button
											variant={DIAGNOSTIC_BUTTON_VARIANT[diagnostic.severity]}
											size="icon"
											aria-label={diagnostic.message}
										>
											<HugeiconsIcon icon={AlertCircleIcon} size={16} />
										</Button>
									</TooltipTrigger>
									<TooltipContent>{diagnostic.message}</TooltipContent>
								</Tooltip>
							))}
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={handleImportClick}
							disabled={isProcessing}
							className="items-center justify-center gap-1.5"
						>
							<HugeiconsIcon icon={CloudUploadIcon} />
							Import
						</Button>
					</div>
				</TooltipProvider>
			}
			ref={containerRef}
		>
			<input
				ref={fileInputRef}
				type="file"
				accept=".srt,.ass"
				className="hidden"
				onChange={(event) => void handleFileChange({ event })}
			/>
			<Section
				showTopBorder={false}
				showBottomBorder={false}
				className="flex-1"
			>
				<SectionContent className="flex flex-col gap-4 h-full pt-1">
					<SectionFields>
						<SectionField label="Language">
							<Select
								value={selectedLanguage}
								onValueChange={(value) => handleLanguageChange({ value })}
							>
								<SelectTrigger>
									<SelectValue placeholder="Select a language" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="auto">Auto detect</SelectItem>
									{TRANSCRIPTION_LANGUAGES.map((language) => (
										<SelectItem key={language.code} value={language.code}>
											{language.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>
						<SectionField label="Words per row">
							<Input
								type="number"
								min={1}
								max={12}
								size="sm"
								value={captionSettings.wordsPerRow}
								onChange={(event) =>
									updateCaptionSetting({
										key: "wordsPerRow",
										value: event.target.value,
									})
								}
							/>
						</SectionField>
						<SectionField label="Rows">
							<Input
								type="number"
								min={1}
								max={4}
								size="sm"
								value={captionSettings.rows}
								onChange={(event) =>
									updateCaptionSetting({
										key: "rows",
										value: event.target.value,
									})
								}
							/>
						</SectionField>
						<SectionField label="In padding %">
							<Input
								type="number"
								min={0}
								max={100}
								step={1}
								size="sm"
								value={captionSettings.inPaddingPercent}
								onChange={(event) =>
									updateCaptionSetting({
										key: "inPaddingPercent",
										value: event.target.value,
									})
								}
							/>
						</SectionField>
						<SectionField label="Out padding %">
							<Input
								type="number"
								min={0}
								max={100}
								step={1}
								size="sm"
								value={captionSettings.outPaddingPercent}
								onChange={(event) =>
									updateCaptionSetting({
										key: "outPaddingPercent",
										value: event.target.value,
									})
								}
							/>
						</SectionField>
						<SectionField label="Hide punctuation">
							<Switch
								checked={captionSettings.hidePunctuation}
								onCheckedChange={(checked) =>
									updateCaptionSettings({
										patch: { hidePunctuation: checked },
									})
								}
								aria-label="Hide punctuation"
							/>
						</SectionField>
						<SectionField label="Placement">
							<Select
								value={captionSettings.placementMode}
								onValueChange={(value) =>
									updateCaptionSetting({
										key: "placementMode",
										value,
									})
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="grid">Grid</SelectItem>
									<SelectItem value="manual">Manual X/Y</SelectItem>
								</SelectContent>
							</Select>
						</SectionField>
						{captionSettings.placementMode === "grid" ? (
							<SectionField
								label={`Grid position (${placementGrid.columns}x${placementGrid.rows})`}
							>
								<div
									className="grid gap-1"
									style={{
										gridTemplateColumns: `repeat(${placementGrid.columns}, minmax(0, 1fr))`,
									}}
								>
									{Array.from({ length: placementGrid.rows }).flatMap(
										(_, rowIndex) =>
											Array.from({ length: placementGrid.columns }).map(
												(__, columnIndex) => {
													const isSelected =
														selectedGridCell.columnIndex === columnIndex &&
														selectedGridCell.rowIndex === rowIndex;
													return (
														<button
															key={`${columnIndex}:${rowIndex}`}
															type="button"
															aria-label={`Place captions at column ${columnIndex + 1}, row ${rowIndex + 1}`}
															className={`border-border bg-input hover:bg-accent focus-visible:ring-ring flex h-7 items-center justify-center rounded-sm border outline-none focus-visible:ring-2 ${
																isSelected ? "border-primary bg-primary/15" : ""
															}`}
															onClick={() =>
																updateCaptionGridCell({
																	columnIndex,
																	rowIndex,
																})
															}
														>
															<span
																className={`size-1.5 rounded-full ${
																	isSelected
																		? "bg-primary"
																		: "bg-muted-foreground/35"
																}`}
															/>
														</button>
													);
												},
											),
									)}
								</div>
							</SectionField>
						) : (
							<SectionField label="Manual X/Y">
								<div className="grid grid-cols-2 gap-2">
									<Input
										type="number"
										step={1}
										size="sm"
										value={captionSettings.manualPositionX}
										aria-label="Caption X position"
										onChange={(event) =>
											updateCaptionSetting({
												key: "manualPositionX",
												value: event.target.value,
											})
										}
									/>
									<Input
										type="number"
										step={1}
										size="sm"
										value={captionSettings.manualPositionY}
										aria-label="Caption Y position"
										onChange={(event) =>
											updateCaptionSetting({
												key: "manualPositionY",
												value: event.target.value,
											})
										}
									/>
								</div>
							</SectionField>
						)}
						<SectionField label="Timing">
							<Select
								value={captionSettings.revealMode}
								onValueChange={(value) =>
									updateCaptionSetting({
										key: "revealMode",
										value,
									})
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CAPTION_REVEAL_MODES.map((mode) => (
										<SelectItem key={mode.value} value={mode.value}>
											{mode.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>
						{usesTransitionIn(captionSettings.revealMode) && (
							<SectionField label="Transition in">
								<Select
									value={captionSettings.transitionIn}
									onValueChange={(value) =>
										updateCaptionSetting({
											key: "transitionIn",
											value,
										})
									}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{CAPTION_TRANSITION_IN_OPTIONS.map((option) => (
											<SelectItem key={option.value} value={option.value}>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</SectionField>
						)}
						{savedPresets.length > 0 && (
							<SectionField label="Saved presets">
								<div className="scrollbar-thin flex max-w-full gap-2 overflow-x-auto pb-1">
									{savedPresets.map((preset) => (
										<ContextMenu key={preset.id}>
											<ContextMenuTrigger asChild>
												<button
													type="button"
													className="bg-accent hover:bg-accent/80 focus-visible:ring-ring flex size-16 shrink-0 items-center justify-center rounded-md border px-1 text-center text-[0.68rem] leading-tight outline-none focus-visible:ring-2"
													title={preset.name}
													onClick={() => loadPreset({ presetId: preset.id })}
												>
													<span className="line-clamp-3 break-words">
														{preset.name}
													</span>
												</button>
											</ContextMenuTrigger>
											<ContextMenuContent>
												<ContextMenuItem
													onSelect={() =>
														void renamePreset({ presetId: preset.id })
													}
												>
													Rename
												</ContextMenuItem>
											</ContextMenuContent>
										</ContextMenu>
									))}
								</div>
							</SectionField>
						)}
						<SectionField label="Word animation">
							<Select
								value={captionSettings.wordAnimationId}
								onValueChange={(value) =>
									value === "none"
										? updateCaptionSettings({
												patch: {
													wordAnimationId: value,
													revealMode: "determined-by-preset",
													transitionIn: "none",
												},
											})
										: updateCaptionSetting({
												key: "wordAnimationId",
												value,
											})
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CAPTION_WORD_ANIMATIONS.map((animation) => (
										<SelectItem key={animation.id} value={animation.id}>
											{animation.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>
						<SectionField label="Accent">
							<Select
								value={captionSettings.accentColor}
								onValueChange={(value) =>
									updateCaptionSetting({
										key: "accentColor",
										value,
									})
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CAPTION_ACCENT_COLORS.map((color) => (
										<SelectItem key={color.value} value={color.value}>
											{color.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>
						<SectionField label="Direction">
							<Select
								value={captionSettings.wordDirection}
								onValueChange={(value) =>
									updateCaptionSetting({
										key: "wordDirection",
										value,
									})
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="auto">Auto</SelectItem>
									<SelectItem value="rtl">Right to left</SelectItem>
									<SelectItem value="ltr">Left to right</SelectItem>
								</SelectContent>
							</Select>
						</SectionField>
					</SectionFields>

					<Button
						type="button"
						variant="outline"
						className="w-full"
						onClick={() => void saveCurrentPreset()}
						disabled={isProcessing}
					>
						Save preset
					</Button>
					<Button
						type="button"
						variant="outline"
						className="w-full"
						onClick={applyCaptionSettings}
						disabled={isProcessing || !hasGeneratedCaptions}
					>
						Apply caption layout
					</Button>
					<Button
						type="button"
						className="mt-auto w-full"
						onClick={() => {
							if (isTranscriptionProcessing) {
								editor.transcription.cancel();
								return;
							}
							void handleGenerateTranscript();
						}}
						disabled={
							isLocalProcessing ||
							transcriptionState.task.status === "cancelling" ||
							(!isTranscriptionProcessing && activeDiagnostics.length > 0)
						}
					>
						{isProcessing && <Spinner className="mr-1" />}
						{isTranscriptionProcessing
							? transcriptionState.task.status === "cancelling"
								? "Cancelling..."
								: `Cancel · ${getTranscriptionStep({ phase: transcriptionState.task.phase })}`
							: isLocalProcessing
								? processing.step
								: "Generate transcript"}
					</Button>
					{error && (
						<div className="bg-destructive/10 border-destructive/20 rounded-md border p-3">
							<p className="text-destructive text-sm">{error}</p>
						</div>
					)}
					{warnings.length > 0 && (
						<div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
							<ul className="space-y-1 text-sm text-amber-700">
								{warnings.map((warning) => (
									<li key={warning}>{warning}</li>
								))}
							</ul>
						</div>
					)}
				</SectionContent>
			</Section>
		</PanelView>
	);
}
