"use client";

import { useParams } from "next/navigation";
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@/components/ui/resizable";
import { AssetsPanel } from "@/components/editor/panels/assets";
import { PropertiesPanel } from "@/components/editor/panels/properties";
import { Timeline } from "@/timeline/components";
import { PreviewPanel } from "@/preview/components";
import { EditorHeader } from "@/components/editor/editor-header";
import { EditorProvider } from "@/components/providers/editor-provider";
import { Onboarding } from "@/components/editor/onboarding";
import { MigrationDialog } from "@/project/components/migration-dialog";
import { usePanelStore } from "@/editor/panel-store";
import { usePasteMedia } from "@/media/use-paste-media";
import { MobileGate } from "@/components/editor/mobile-gate";
import { useCallback, useMemo, useState } from "react";
import {
	useEditorPlayback,
	useEditorProject,
	useEditorRenderer,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { ChangelogNotification } from "@/changelog/components/changelog-notification";
import { StoragePersistenceDialog } from "@/services/storage/components/storage-persistence-dialog";
import {
	createPreviewOverlayControl,
	isPreviewOverlayVisible,
	mergePreviewOverlaySources,
} from "@/preview/overlays";
import { usePreviewStore } from "@/preview/preview-store";
import {
	getSafeAreaPreviewOverlaySource,
	safeAreaPreviewOverlay,
} from "@/preview/safe-area-overlay";
import { getGuidePreviewOverlaySource } from "@/guides";
import {
	bookmarkNotesPreviewOverlay,
	getBookmarkPreviewOverlaySource,
} from "@/timeline/bookmarks/index";
import { getParallaxCanvasPreviewOverlaySource } from "@/parallax-story-teller/preview-overlay";
import { useCameraManStore } from "@/parallax-story-teller/camera-man-store";
import { ParallaxCanvasEditorBanner } from "@/parallax-story-teller/editor-banner";
import { ZERO_MEDIA_TIME } from "@/wasm";
import type { EditorCore } from "@/core";

export default function Editor() {
	const params = useParams();
	const projectId = params.project_id as string;

	return (
		<MobileGate>
			<EditorProvider projectId={projectId}>
				<div className="bg-background flex h-screen w-screen flex-col overflow-hidden">
					<DegradedRendererBanner />
					<EditorHeader />
					<div className="min-h-0 min-w-0 flex-1">
						<EditorLayout />
					</div>
					<Onboarding />
					<MigrationDialog />
					<StoragePersistenceDialog />
					<ChangelogNotification />
				</div>
			</EditorProvider>
		</MobileGate>
	);
}

function DegradedRendererBanner() {
	const isDegraded = useEditorRenderer((e) => e.renderer.isDegraded);
	const [dismissed, setDismissed] = useState(false);
	if (!isDegraded || dismissed) return null;

	return (
		<div className="bg-accent border-b h-9 flex items-center justify-center gap-2 text-xs text-muted-foreground">
			<span>For the best experience, open OpenCut in Chrome.</span>
			<Button
				variant="text"
				size="icon"
				className="p-0 w-auto [&_svg]:size-3.5"
				onClick={() => setDismissed(true)}
				aria-label="Dismiss"
			>
				<HugeiconsIcon icon={Cancel01Icon} />
			</Button>
		</div>
	);
}

function PreviewPanelWithOverlays() {
	const [activeScene, sceneDuration] = useEditorTimelineScenes((editor) => [
		editor.scenes.getActiveSceneOrNull(),
		editor.timeline.getTotalDuration(),
	]);
	const project = useEditorProject((editor) => editor.project.getActive());
	const cameraManPhase = useCameraManStore((state) => state.phase);
	const cameraManSceneId = useCameraManStore((state) => state.sceneId);
	const cameraManCurrent = useCameraManStore((state) => state.current);
	const activeGuide = usePreviewStore((state) => state.activeGuide);
	const overlays = usePreviewStore((state) => state.overlays);
	const setOverlayVisibility = usePreviewStore(
		(state) => state.setOverlayVisibility,
	);
	const showBookmarkNotes = isPreviewOverlayVisible({
		overlay: bookmarkNotesPreviewOverlay,
		overlays,
	});
	const showSafeArea = isPreviewOverlayVisible({
		overlay: safeAreaPreviewOverlay,
		overlays,
	});
	const shouldTrackOverlayTime = Boolean(activeScene?.parallax) || showBookmarkNotes;
	const selectOverlayTime = useCallback(
		(editor: EditorCore) =>
			shouldTrackOverlayTime
				? editor.playback.getCurrentTime()
				: ZERO_MEDIA_TIME,
		[shouldTrackOverlayTime],
	);
	const currentTime = useEditorPlayback(selectOverlayTime);

	const overlaySource = useMemo(
		() =>
			mergePreviewOverlaySources({
				sources: [
					getParallaxCanvasPreviewOverlaySource({
						scene: activeScene,
						canvasSize: project?.settings.canvasSize,
						currentTime,
						duration: sceneDuration,
						cameraOverride:
							cameraManPhase !== "idle" && cameraManSceneId === activeScene?.id
								? cameraManCurrent
								: null,
					}),
					getSafeAreaPreviewOverlaySource({
						isVisible: showSafeArea,
					}),
					getGuidePreviewOverlaySource({
						guideId: activeGuide,
					}),
					activeScene
						? getBookmarkPreviewOverlaySource({
								bookmarks: activeScene.bookmarks,
								time: currentTime,
								isVisible: showBookmarkNotes,
							})
						: {
								definitions: [bookmarkNotesPreviewOverlay],
								instances: [],
							},
				],
			}),
		[
			activeGuide,
			activeScene,
			cameraManCurrent,
			cameraManPhase,
			cameraManSceneId,
			currentTime,
			project?.settings.canvasSize,
			sceneDuration,
			showBookmarkNotes,
			showSafeArea,
		],
	);

	const overlayControls = useMemo(
		() =>
			overlaySource.definitions.map((overlay) =>
				createPreviewOverlayControl({ overlay, overlays }),
			),
		[overlaySource.definitions, overlays],
	);

	return (
		<PreviewPanel
			overlayControls={overlayControls}
			overlayInstances={overlaySource.instances}
			onOverlayVisibilityChange={setOverlayVisibility}
		/>
	);
}

function EditorLayout() {
	usePasteMedia();
	const { panels, setPanel } = usePanelStore();

	return (
		<div className="flex size-full min-h-0 flex-col">
			<ParallaxCanvasEditorBanner />
		<ResizablePanelGroup
			direction="vertical"
			className="size-full gap-[0.18rem]"
			onLayout={(sizes) => {
				setPanel({
					panel: "mainContent",
					size: sizes[0] ?? panels.mainContent,
				});
				setPanel({
					panel: "timeline",
					size: sizes[1] ?? panels.timeline,
				});
			}}
		>
			<ResizablePanel
				defaultSize={panels.mainContent}
				minSize={30}
				maxSize={85}
				className="min-h-0"
			>
				<ResizablePanelGroup
					direction="horizontal"
					className="size-full gap-[0.19rem] px-3"
					onLayout={(sizes) => {
						setPanel({ panel: "tools", size: sizes[0] ?? panels.tools });
						setPanel({ panel: "preview", size: sizes[1] ?? panels.preview });
						setPanel({
							panel: "properties",
							size: sizes[2] ?? panels.properties,
						});
					}}
				>
					<ResizablePanel
						defaultSize={panels.tools}
						minSize={15}
						maxSize={40}
						className="min-w-0"
					>
						<AssetsPanel />
					</ResizablePanel>

					<ResizableHandle withHandle />

					<ResizablePanel
						defaultSize={panels.preview}
						minSize={30}
						className="min-h-0 min-w-0 flex-1"
					>
						<PreviewPanelWithOverlays />
					</ResizablePanel>

					<ResizableHandle withHandle />

					<ResizablePanel
						defaultSize={panels.properties}
						minSize={15}
						maxSize={40}
						className="min-w-0"
					>
						<PropertiesPanel />
					</ResizablePanel>
				</ResizablePanelGroup>
			</ResizablePanel>

			<ResizableHandle withHandle />

			<ResizablePanel
				defaultSize={panels.timeline}
				minSize={15}
				maxSize={70}
				className="min-h-0 px-3 pb-3"
			>
				<Timeline />
			</ResizablePanel>
		</ResizablePanelGroup>
		</div>
	);
}
