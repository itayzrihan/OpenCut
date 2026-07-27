import {
	useEditorMediaAsset,
	useEditorPlayback,
	useEditorProject,
	useEditorTimelineScenes,
	useEditorTimelineSelection,
} from "@/editor/use-editor";
import {
	TooltipProvider,
	Tooltip,
	TooltipTrigger,
	TooltipContent,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import {
	SplitButton,
	SplitButtonLeft,
	SplitButtonRight,
	SplitButtonSeparator,
} from "@/components/ui/split-button";
import { Slider } from "@/components/ui/slider";
import { TIMELINE_ZOOM_BUTTON_FACTOR } from "./interaction";
import { TIMELINE_ZOOM_MAX } from "@/timeline/scale";
import { sliderToZoom, zoomToSlider } from "@/timeline/zoom-utils";
import { ScenesView } from "@/components/editor/scenes-view";
import { type TActionWithOptionalArgs, invokeAction } from "@/actions";
import {
	canToggleSourceAudio,
	getSourceAudioActionLabel,
	isSourceAudioSeparated,
} from "@/timeline/audio-separation";
import { hasMediaId } from "@/timeline";
import { cn } from "@/utils/ui";
import { useTimelineStore } from "@/timeline/timeline-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Bookmark02Icon,
	Delete02Icon,
	SnowIcon,
	ScissorIcon,
	MagnetIcon,
	SearchAddIcon,
	SearchMinusIcon,
	Copy01Icon,
	AlignLeftIcon,
	AlignRightIcon,
	Link02Icon,
	Layers01Icon,
	Chart03Icon,
	Unlink02Icon,
	CursorRectangleSelection01Icon,
	ArrowDown01Icon,
	AiAudioIcon,
	AudioWave01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { OcRippleIcon } from "@/components/icons";
import { GraphEditorPopover } from "./graph-editor/popover";
import { PopoverTrigger } from "@/components/ui/popover";
import { useGraphEditorController } from "./graph-editor/use-controller";
import { getToolbarFrameTime } from "./toolbar-frame-time";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
	CUT_SILENCE_ACTIONS,
	DEFAULT_CUT_SILENCE_MODE,
	executeCutSilenceAction,
	type CutSilenceMode,
} from "./cut-silence-toolbar-options";

export function TimelineToolbar({
	zoomLevel,
	minZoom,
	setZoomLevel,
}: {
	zoomLevel: number;
	minZoom: number;
	setZoomLevel: ({ zoom }: { zoom: number }) => void;
}) {
	const handleZoom = ({ direction }: { direction: "in" | "out" }) => {
		const newZoomLevel =
			direction === "in"
				? Math.min(TIMELINE_ZOOM_MAX, zoomLevel * TIMELINE_ZOOM_BUTTON_FACTOR)
				: Math.max(minZoom, zoomLevel / TIMELINE_ZOOM_BUTTON_FACTOR);
		setZoomLevel({ zoom: newZoomLevel });
	};

	return (
		<ScrollArea className="scrollbar-hidden">
			<div className="flex h-10 items-center justify-between border-b px-2 py-1">
				<ToolbarLeftSection />

				<SceneSelector />

				<ToolbarRightSection
					zoomLevel={zoomLevel}
					minZoom={minZoom}
					onZoomChange={(zoom) => setZoomLevel({ zoom })}
					onZoom={handleZoom}
				/>
			</div>
		</ScrollArea>
	);
}

function ToolbarLeftSection() {
	const timeline = useEditorTimelineScenes((editor) => editor.timeline);
	const graphEditor = useGraphEditorController();
	const aiRangeSelection = useTimelineStore((s) => s.aiRangeSelection);
	const armRangeSelection = useTimelineStore((s) => s.armRangeSelection);
	const selectedElements = useEditorTimelineSelection((editor) =>
		editor.selection.getSelectedElements(),
	);
	const selectedTimelineElements = timeline.getElementsWithTracks({
		elements: selectedElements,
	});
	const selectedElement =
		selectedTimelineElements.length === 1 ? selectedTimelineElements[0] : null;
	const hasSelectedVideo = selectedTimelineElements.some(
		({ element }) => element.type === "video",
	);
	const selectedMediaId =
		selectedElement && hasMediaId(selectedElement.element)
			? selectedElement.element.mediaId
			: null;
	const selectedMediaAsset = useEditorMediaAsset({ mediaId: selectedMediaId });
	const canToggleSelectedSourceAudio =
		!!selectedElement &&
		canToggleSourceAudio(selectedElement.element, selectedMediaAsset);
	const sourceAudioLabel =
		selectedElement?.element.type === "video"
			? getSourceAudioActionLabel({
					element: selectedElement.element,
				})
			: "Extract audio";
	const isSelectedSourceAudioSeparated =
		selectedElement?.element.type === "video" &&
		isSourceAudioSeparated({
			element: selectedElement.element,
		});

	const handleAction = ({
		action,
		event,
	}: {
		action: TActionWithOptionalArgs;
		event: React.MouseEvent;
	}) => {
		event.stopPropagation();
		invokeAction(action);
	};

	return (
		<div className="flex items-center gap-1">
			<TooltipProvider delayDuration={500}>
				<ToolbarButton
					icon={<HugeiconsIcon icon={ScissorIcon} />}
					tooltip="Split element"
					onClick={({ event }) => handleAction({ action: "split", event })}
				/>
				<CutSilenceToolbarControl
					hasSelectedVideo={hasSelectedVideo}
					removeAllSilence={(options) => timeline.removeAllSilence(options)}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={AlignLeftIcon} />}
					tooltip="Split left"
					onClick={({ event }) => handleAction({ action: "split-left", event })}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={AlignRightIcon} />}
					tooltip="Split right"
					onClick={({ event }) =>
						handleAction({ action: "split-right", event })
					}
				/>

				<ToolbarButton
					icon={
						<HugeiconsIcon
							icon={isSelectedSourceAudioSeparated ? Unlink02Icon : Link02Icon}
						/>
					}
					tooltip={sourceAudioLabel}
					disabled={!canToggleSelectedSourceAudio}
					onClick={({ event }) =>
						handleAction({ action: "toggle-source-audio", event })
					}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={Copy01Icon} />}
					tooltip="Duplicate element"
					onClick={({ event }) =>
						handleAction({ action: "duplicate-selected", event })
					}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={SnowIcon} />}
					tooltip="Freeze frame (coming soon)"
					disabled={true}
					onClick={({ event: _event }) => {}}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={Delete02Icon} />}
					tooltip="Delete element"
					onClick={({ event }) =>
						handleAction({ action: "delete-selected", event })
					}
				/>

				<div className="bg-border mx-1 h-6 w-px" />

				<BookmarkToolbarButton />

				<ToolbarButton
					icon={<HugeiconsIcon icon={CursorRectangleSelection01Icon} />}
					isActive={aiRangeSelection.mode !== "idle"}
					tooltip={
						aiRangeSelection.mode === "idle"
							? "Select AI range"
							: aiRangeSelection.mode === "selected"
								? "Clear AI range"
								: "Cancel AI range"
					}
					onClick={({ event }) => {
						event.stopPropagation();
						armRangeSelection();
					}}
				/>

				<GraphEditorPopover
					open={graphEditor.open}
					onOpenChange={graphEditor.onOpenChange}
					value={
						graphEditor.state.status === "ready"
							? graphEditor.state.cubicBezier
							: null
					}
					message={graphEditor.state.message}
					componentOptions={graphEditor.state.componentOptions}
					activeComponentKey={graphEditor.state.activeComponentKey}
					onActiveComponentKeyChange={graphEditor.onActiveComponentKeyChange}
					onPreviewValue={graphEditor.onPreviewValue}
					onCommitValue={graphEditor.onCommitValue}
					onCancelPreview={graphEditor.onCancelPreview}
				>
					<ToolbarButton
						icon={<HugeiconsIcon icon={Chart03Icon} />}
						tooltip={graphEditor.tooltip}
						disabled={!graphEditor.canOpen}
						buttonWrapper={(button) =>
							graphEditor.canOpen ? (
								<PopoverTrigger asChild>{button}</PopoverTrigger>
							) : (
								button
							)
						}
					/>
				</GraphEditorPopover>
			</TooltipProvider>
		</div>
	);
}

function CutSilenceToolbarControl({
	hasSelectedVideo,
	removeAllSilence,
}: {
	hasSelectedVideo: boolean;
	removeAllSilence: (options: { mode: CutSilenceMode }) => Promise<unknown>;
}) {
	const [activeMode, setActiveMode] = useState<CutSilenceMode | null>(null);
	const activeRunRef = useRef(false);
	const isAnalyzing = activeMode !== null;
	const disabled = !hasSelectedVideo || isAnalyzing;

	const runCutSilence = async ({ mode }: { mode: CutSilenceMode }) => {
		if (!hasSelectedVideo || activeRunRef.current) return;
		activeRunRef.current = true;
		setActiveMode(mode);
		try {
			await executeCutSilenceAction({ mode, removeAllSilence });
			if (mode === "deep") {
				toast.success("Deep silence analysis complete", {
					description:
						"Speech boundaries and caption timing were refined where needed.",
				});
			}
		} catch (error) {
			console.error(`Failed to run ${mode} silence removal:`, error);
			toast.error("Could not cut silences", {
				description:
					error instanceof Error ? error.message : "Please try again.",
			});
		} finally {
			activeRunRef.current = false;
			setActiveMode(null);
		}
	};

	const mainTooltip = !hasSelectedVideo
		? "Select one or more video clips to cut silences"
		: activeMode === "deep"
			? "Deeply analyzing speech, noise, and caption timing"
			: activeMode === "fast"
				? "Cutting clear silences"
				: "Cut silences quickly (open the menu for Deep audio analysis)";

	return (
		<div
			role="group"
			aria-label="Cut silences"
			aria-busy={isAnalyzing}
			className="flex items-center"
		>
			<ToolbarButton
				icon={
					isAnalyzing ? (
						<Spinner className="size-3.5" />
					) : (
						<HugeiconsIcon icon={AudioWave01Icon} />
					)
				}
				tooltip={mainTooltip}
				disabled={disabled}
				className="rounded-r-none"
				onClick={({ event }) => {
					event.stopPropagation();
					void runCutSilence({ mode: DEFAULT_CUT_SILENCE_MODE });
				}}
			/>

			<DropdownMenu>
				<ToolbarButton
					icon={<HugeiconsIcon icon={ArrowDown01Icon} className="size-3" />}
					tooltip="Cut silence modes: Fast or Deep audio analysis"
					disabled={disabled}
					className="h-7 w-4 rounded-l-none px-0"
					buttonWrapper={(button) => (
						<DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
					)}
				/>
				<DropdownMenuContent align="start" className="w-80">
					<DropdownMenuLabel>Cut silences</DropdownMenuLabel>
					{CUT_SILENCE_ACTIONS.map((action) => (
						<DropdownMenuItem
							key={action.mode}
							onSelect={() => void runCutSilence({ mode: action.mode })}
							icon={
								<HugeiconsIcon
									icon={action.mode === "deep" ? AiAudioIcon : SnowIcon}
								/>
							}
							className="items-start py-2"
						>
							<span className="min-w-0">
								<span className="block font-medium text-foreground">
									{action.label}
								</span>
								<span className="text-muted-foreground block text-xs leading-snug whitespace-normal">
									{action.description}
								</span>
							</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

function BookmarkToolbarButton() {
	const fps = useEditorProject((e) => e.project.getActive().settings.fps);
	const currentFrameTime = useEditorPlayback((e) =>
		getToolbarFrameTime({
			time: e.playback.getCurrentTime(),
			fps,
		}),
	);
	const isCurrentlyBookmarked = useEditorTimelineScenes((e) =>
		e.scenes.isBookmarked({ time: currentFrameTime }),
	);

	return (
		<ToolbarButton
			icon={<HugeiconsIcon icon={Bookmark02Icon} />}
			isActive={isCurrentlyBookmarked}
			tooltip={isCurrentlyBookmarked ? "Remove bookmark" : "Add bookmark"}
			onClick={({ event }) => {
				event.stopPropagation();
				invokeAction("toggle-bookmark");
			}}
		/>
	);
}

function SceneSelector() {
	const currentScene = useEditorTimelineScenes((editor) =>
		editor.scenes.getActiveScene(),
	);

	return (
		<div>
			<SplitButton className="border-foreground/10 border">
				<SplitButtonLeft>{currentScene?.name || "No Scene"}</SplitButtonLeft>
				<SplitButtonSeparator />
				<ScenesView>
					<SplitButtonRight onClick={() => {}}>
						<HugeiconsIcon icon={Layers01Icon} className="size-4" />
					</SplitButtonRight>
				</ScenesView>
			</SplitButton>
		</div>
	);
}

function ToolbarRightSection({
	zoomLevel,
	minZoom,
	onZoomChange,
	onZoom,
}: {
	zoomLevel: number;
	minZoom: number;
	onZoomChange: (zoom: number) => void;
	onZoom: (options: { direction: "in" | "out" }) => void;
}) {
	const snappingEnabled = useTimelineStore((s) => s.snappingEnabled);
	const rippleEditingEnabled = useTimelineStore((s) => s.rippleEditingEnabled);
	const toggleSnapping = useTimelineStore((s) => s.toggleSnapping);
	const toggleRippleEditing = useTimelineStore((s) => s.toggleRippleEditing);

	return (
		<div className="flex items-center gap-1">
			<TooltipProvider delayDuration={500}>
				<ToolbarButton
					icon={<HugeiconsIcon icon={MagnetIcon} />}
					isActive={snappingEnabled}
					tooltip="Auto snapping"
					onClick={() => toggleSnapping()}
				/>

				<ToolbarButton
					icon={<OcRippleIcon size={24} className="scale-110" />}
					isActive={rippleEditingEnabled}
					tooltip="Ripple editing"
					onClick={() => toggleRippleEditing()}
				/>
			</TooltipProvider>

			<div className="bg-border mx-1 h-6 w-px" />

			<div className="flex items-center gap-1">
				<Button
					variant="text"
					size="icon"
					onClick={() => onZoom({ direction: "out" })}
				>
					<HugeiconsIcon icon={SearchMinusIcon} />
				</Button>
				<Slider
					className="w-28"
					value={[zoomToSlider({ zoomLevel, minZoom })]}
					onValueChange={(values) =>
						onZoomChange(sliderToZoom({ sliderPosition: values[0], minZoom }))
					}
					min={0}
					max={1}
					step={0.005}
				/>
				<Button
					variant="text"
					size="icon"
					onClick={() => onZoom({ direction: "in" })}
				>
					<HugeiconsIcon icon={SearchAddIcon} />
				</Button>
			</div>
		</div>
	);
}

function ToolbarButton({
	icon,
	tooltip,
	onClick,
	disabled,
	isActive,
	buttonWrapper,
	className,
}: {
	icon: React.ReactNode;
	tooltip: string;
	onClick?: ({ event }: { event: React.MouseEvent }) => void;
	disabled?: boolean;
	isActive?: boolean;
	buttonWrapper?: (button: React.ReactElement) => React.ReactElement;
	className?: string;
}) {
	const button = (
		<Button
			variant={isActive ? "secondary" : "text"}
			size="icon"
			aria-label={tooltip}
			disabled={disabled}
			onClick={onClick ? (event) => onClick({ event }) : undefined}
			className={cn(
				"rounded-sm",
				disabled ? "cursor-not-allowed opacity-50" : "",
				className,
			)}
		>
			{icon}
		</Button>
	);
	const trigger = disabled ? (
		<span className="inline-flex">{button}</span>
	) : buttonWrapper ? (
		buttonWrapper(button)
	) : (
		button
	);

	return (
		<Tooltip delayDuration={200}>
			<TooltipTrigger asChild>{trigger}</TooltipTrigger>
			<TooltipContent>{tooltip}</TooltipContent>
		</Tooltip>
	);
}
