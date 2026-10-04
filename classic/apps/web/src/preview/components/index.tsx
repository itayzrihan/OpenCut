"use client";

import {
	Profiler,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ProfilerOnRenderCallback } from "react";
import useDeepCompareEffect from "use-deep-compare-effect";
import {
	useEditor,
	useEditorMedia,
	useEditorProject,
	useEditorRenderer,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import { useContainerSize } from "@/hooks/use-container-size";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import {
	HyperframesLivePreview,
	findHyperframesLiveLayers,
} from "@/hyperframes/live-preview";
import {
	PreviewPlaybackProbe,
	forceHyperframesCaptureForDiagnostics,
} from "@/diagnostics/preview-playback";
import { TICKS_PER_SECOND } from "@/wasm";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import { buildScene } from "@/services/renderer/scene-builder";
import { backgroundRemovalService } from "@/services/background-removal";
import { PreviewOverlayLayer } from "./overlay-layer";
import { PreviewInteractionOverlay } from "./preview-interaction-overlay";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import type {
	PreviewOverlayControl,
	PreviewOverlayInstance,
} from "@/preview/overlays";
import { PreviewContextMenu } from "./context-menu";
import { PreviewToolbar } from "./toolbar";
import {
	PreviewViewportProvider,
	usePreviewViewportState,
} from "./preview-viewport";
import {
	incrementCounter,
	isRenderPerfEnabled,
	recordFrameInterval,
	recordSpan,
} from "@/diagnostics/render-perf";
import {
	recordCameraManSample,
	useCameraManStore,
} from "@/parallax-story-teller/camera-man-store";
import { getPreviewRenderSize } from "../render-size";
import { OfflineMediaPanel } from "./offline-media";
import { Button } from "@/components/ui/button";

function usePreviewSize() {
	const canvasSize = useEditorProject(
		(e) => e.project.getActive()?.settings.canvasSize,
	);
	const activeScene = useEditorTimelineScenes((e) =>
		e.scenes.getActiveSceneOrNull(),
	);
	const worldWidthFrames = activeScene?.parallax?.worldWidthFrames ?? 1;
	const worldHeightFrames = activeScene?.parallax?.worldHeightFrames ?? 1;

	return {
		width: canvasSize ? canvasSize.width * worldWidthFrames : 1,
		height: canvasSize ? canvasSize.height * worldHeightFrames : 1,
	};
}

function normalizeWheelDelta({
	delta,
	deltaMode,
	pageSize,
}: {
	delta: number;
	deltaMode: number;
	pageSize: number;
}): number {
	if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
		return delta * 16;
	}

	if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
		return delta * pageSize;
	}

	return delta;
}

export function PreviewPanel({
	overlayControls,
	overlayInstances,
	onOverlayVisibilityChange,
}: {
	overlayControls: PreviewOverlayControl[];
	overlayInstances: PreviewOverlayInstance[];
	onOverlayVisibilityChange: (params: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	const { toggleFullscreen } = useFullscreen({ containerRef });
	const handleContainerRef = useCallback((node: HTMLDivElement | null) => {
		containerRef.current = node;
		setContainer(node);
	}, []);

	return (
		<div
			ref={handleContainerRef}
			className="panel bg-background relative flex size-full min-h-0 min-w-0 flex-col rounded-sm border"
		>
			<OfflineMediaPanel />
			<PreviewCanvas
				container={container}
				onToggleFullscreen={toggleFullscreen}
				overlayControls={overlayControls}
				overlayInstances={overlayInstances}
				onOverlayVisibilityChange={onOverlayVisibilityChange}
			/>
			<RenderTreeController />
		</div>
	);
}

function RenderTreeController() {
	const editor = useEditor();
	const [tracks, scenes, activeScene] = useEditorTimelineScenes((e) => [
		e.timeline.getPreviewTracks() ?? e.scenes.getActiveScene().tracks,
		e.scenes.getScenes(),
		e.scenes.getActiveScene(),
	]);
	const mediaAssets = useEditorMedia((e) => e.media.getAssets());
	const activeProject = useEditorProject((e) => e.project.getActive());
	const hyperframesResourceRevision = useEditorRenderer((e) =>
		e.renderer.getHyperframesResourceRevision(),
	);

	const { width, height } = usePreviewSize();

	useDeepCompareEffect(() => {
		if (!activeProject) return;

		const duration = editor.timeline.getTotalDuration();
		const renderTree = buildScene({
			hyperframes: editor.renderer.getHyperframesRenderContext(),
			tracks,
			mediaAssets,
			duration,
			canvasSize: { width, height },
			cameraCanvasSize: activeProject.settings.canvasSize,
			background: activeProject.settings.background,
			isPreview: true,
			scenes,
			activeSceneId: activeScene.id,
		});

		editor.renderer.setRenderTree({ renderTree });
	}, [
		tracks,
		mediaAssets,
		activeProject?.settings.background,
		activeProject?.hyperframesCompositions,
		hyperframesResourceRevision,
		width,
		height,
		scenes,
		activeScene.id,
	]);

	return null;
}

function PreviewCanvas({
	container,
	onToggleFullscreen,
	overlayControls,
	overlayInstances,
	onOverlayVisibilityChange,
}: {
	container: HTMLElement | null;
	onToggleFullscreen: () => void;
	overlayControls: PreviewOverlayControl[];
	overlayInstances: PreviewOverlayInstance[];
	onOverlayVisibilityChange: (params: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
}) {
	const canvasMountRef = useRef<HTMLDivElement>(null);
	const liveMountRef = useRef<HTMLDivElement>(null);
	const livePreviewRef = useRef<HyperframesLivePreview | null>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const lastFrameRef = useRef(-1);
	const lastSceneRef = useRef<RootNode | null>(null);
	const renderingRef = useRef(false);
	const renderPromiseRef = useRef<Promise<void>>(Promise.resolve());
	const pendingRenderRef = useRef(false);
	const scheduledRenderRef = useRef<number | null>(null);
	const isExportingRef = useRef(false);
	const runRenderRef = useRef<() => void>(() => {});
	const renderAttemptRef = useRef<object | null>(null);
	const preparingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [isPreparing, setIsPreparing] = useState(false);
	const [previewFailed, setPreviewFailed] = useState(false);
	const [previewRetry, setPreviewRetry] = useState(0);
	const { width: nativeWidth, height: nativeHeight } = usePreviewSize();
	const viewportSize = useContainerSize({ containerRef: viewportRef });
	const editor = useEditor();
	const playbackProbe = useMemo(() => new PreviewPlaybackProbe(), []);
	const activeProject = useEditorProject((e) => e.project.getActive());
	const renderTree = useEditorRenderer((e) => e.renderer.getRenderTree());
	const isExporting = useEditorRenderer((e) => e.renderer.isExporting);
	isExportingRef.current = isExporting;
	const viewport = usePreviewViewportState({
		canvasHeight: nativeHeight,
		canvasWidth: nativeWidth,
		viewportHeight: viewportSize.height,
		viewportRef,
		viewportWidth: viewportSize.width,
	});
	const { canPan, panByScreenDelta, scaleZoom } = viewport;
	const previewRenderSize = useMemo(
		() =>
			getPreviewRenderSize({
				logicalWidth: nativeWidth,
				logicalHeight: nativeHeight,
				viewportWidth: viewportSize.width,
				viewportHeight: viewportSize.height,
				devicePixelRatio:
					typeof window === "undefined" ? 1 : window.devicePixelRatio,
			}),
		[nativeHeight, nativeWidth, viewportSize.height, viewportSize.width],
	);

	const handleProfilerRender = useCallback<ProfilerOnRenderCallback>(
		(...args) => {
			if (!isRenderPerfEnabled()) return;

			const [, , actualDuration, , startTime, commitTime] = args;
			recordSpan({
				name: "react.previewRender",
				durationMs: actualDuration,
			});
			recordSpan({
				name: "react.previewCommit",
				durationMs: Math.max(0, commitTime - startTime),
			});
		},
		[],
	);

	const renderer = useMemo(() => {
		return new CanvasRenderer({
			width: previewRenderSize.width,
			height: previewRenderSize.height,
			logicalWidth: nativeWidth,
			logicalHeight: nativeHeight,
			fps: activeProject.settings.fps,
		});
	}, [
		nativeWidth,
		nativeHeight,
		previewRenderSize.width,
		previewRenderSize.height,
		activeProject.settings.fps,
	]);

	useEffect(() => {
		const mount = canvasMountRef.current;
		if (!mount) return;

		let disposed = false;
		let outputCanvas: HTMLCanvasElement | null = null;
		void renderer
			.getOutputCanvas()
			.then((canvas) => {
				if (disposed) return;
				outputCanvas = canvas;
				canvas.style.display = "block";
				canvas.style.width = "100%";
				canvas.style.height = "100%";
				mount.appendChild(canvas);
			})
			.catch((error: unknown) => {
				if (!disposed) setPreviewFailed(true);
				console.error("Failed to mount preview canvas:", error);
			});

		return () => {
			disposed = true;
			if (outputCanvas?.parentElement === mount) {
				mount.removeChild(outputCanvas);
			}
		};
	}, [renderer, previewRetry]);

	const scheduleRender = useCallback(
		(reason: string) => {
			if (isExportingRef.current || editor.renderer.isExporting) {
				incrementCounter({ name: "preview.renderSkipped.export" });
				return;
			}

			incrementCounter({ name: "preview.renderRequest" });
			incrementCounter({ name: `preview.renderRequest.${reason}` });

			if (renderingRef.current) {
				pendingRenderRef.current = true;
				incrementCounter({ name: "preview.renderCoalesced" });
				return;
			}

			// Playback updates already run inside the transport's animation frame.
			// Starting here avoids delaying every preview by another display frame.
			if (reason === "playback") {
				if (scheduledRenderRef.current !== null) {
					cancelAnimationFrame(scheduledRenderRef.current);
					scheduledRenderRef.current = null;
				}
				runRenderRef.current();
				return;
			}

			if (scheduledRenderRef.current !== null) {
				pendingRenderRef.current = true;
				incrementCounter({ name: "preview.renderCoalesced" });
				return;
			}

			scheduledRenderRef.current = requestAnimationFrame(() => {
				scheduledRenderRef.current = null;
				runRenderRef.current();
			});
		},
		[editor.renderer],
	);

	useEffect(() => {
		if (
			!liveMountRef.current ||
			isExporting ||
			forceHyperframesCaptureForDiagnostics()
		)
			return;
		const live = new HyperframesLivePreview({
			mount: liveMountRef.current,
			width: nativeWidth,
			height: nativeHeight,
			onFallback: () => {
				lastFrameRef.current = -1;
				scheduleRender("hyperframesFallback");
			},
		});
		livePreviewRef.current = live;
		return () => {
			live.dispose();
			if (livePreviewRef.current === live) livePreviewRef.current = null;
		};
	}, [
		renderer,
		nativeWidth,
		nativeHeight,
		previewRetry,
		scheduleRender,
		isExporting,
	]);

	const render = useCallback(() => {
		if (!renderTree || isExportingRef.current || editor.renderer.isExporting) {
			return;
		}
		if (renderingRef.current) {
			pendingRenderRef.current = true;
			incrementCounter({ name: "preview.renderCoalesced" });
			return renderPromiseRef.current;
		}

		const renderTime = Math.min(
			editor.playback.getCurrentTime(),
			editor.timeline.getLastFrameTime(),
		);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * renderer.fps.denominator) / renderer.fps.numerator,
		);
		const frame = Math.floor(renderTime / ticksPerFrame);

		if (frame === lastFrameRef.current && renderTree === lastSceneRef.current) {
			incrementCounter({ name: "preview.renderSkipped.sameFrame" });
			return;
		}

		renderingRef.current = true;
		pendingRenderRef.current = false;
		const attempt = {};
		renderAttemptRef.current = attempt;
		setPreviewFailed(false);
		preparingTimerRef.current = setTimeout(() => {
			if (renderAttemptRef.current === attempt) setIsPreparing(true);
		}, 250);
		lastSceneRef.current = renderTree;
		lastFrameRef.current = frame;
		const start = performance.now();
		const ticket = playbackProbe.beginFrame({ frame });
		const rendered = livePreviewRef.current
			? livePreviewRef.current.render({
					node: renderTree,
					time: renderTime,
					renderer,
					playing: editor.playback.getIsPlaying(),
					clockTime: editor.playback.getClockTime(),
				})
			: renderer.render({ node: renderTree, time: renderTime });
		const completion = rendered
			.then(() => {
				if (ticket) {
					playbackProbe.completeFrame({
						ticket,
						transportLagMs:
							(Math.max(0, editor.playback.getCurrentTime() - renderTime) *
								1000) /
							TICKS_PER_SECOND,
					});
				}
				incrementCounter({ name: "preview.rendered" });
				recordSpan({
					name: "preview.renderTotal",
					durationMs: performance.now() - start,
				});
				recordFrameInterval({ name: "preview.frame" });
			})
			.catch((error: unknown) => {
				playbackProbe.failFrame({ ticket });
				lastFrameRef.current = -1;
				if (renderAttemptRef.current === attempt) setPreviewFailed(true);
				console.error("Preview render failed:", error);
			})
			.finally(() => {
				if (renderAttemptRef.current === attempt) {
					if (preparingTimerRef.current !== null) {
						clearTimeout(preparingTimerRef.current);
						preparingTimerRef.current = null;
					}
					setIsPreparing(false);
				}
				const hasQueuedRender = pendingRenderRef.current;
				if (hasQueuedRender) {
					incrementCounter({ name: "preview.renderStale" });
				}

				renderingRef.current = false;
				if (
					hasQueuedRender &&
					!isExportingRef.current &&
					!editor.renderer.isExporting
				) {
					pendingRenderRef.current = false;
					scheduleRender("queued");
				}
			});
		renderPromiseRef.current = completion;
		return completion;
	}, [
		renderer,
		renderTree,
		editor.playback,
		editor.renderer,
		editor.timeline,
		scheduleRender,
		playbackProbe,
	]);

	useEffect(() => {
		let active = true;
		const unregister = editor.playback.registerPlaybackPreparer({
			id: "hyperframes-live-preview",
			prepare: async ({ time, signal }) => {
				if (
					!livePreviewRef.current ||
					!renderTree ||
					!findHyperframesLiveLayers({ node: renderTree, time }).length
				)
					return;
				// A replay can seek from the final scene back to undecoded video.
				// Finish the paused frame before the shared transport and mixer start.
				await renderPromiseRef.current;
				signal.throwIfAborted();
				if (!active) return;
				lastFrameRef.current = -1;
				await render();
			},
		});
		return () => {
			active = false;
			unregister();
		};
	}, [editor.playback, render, renderTree]);

	useEffect(() => {
		const sync = () =>
			playbackProbe.setPlaying({
				playing: editor.playback.getIsPlaying() && !isExporting,
				fps: renderer.fps.numerator / renderer.fps.denominator,
			});
		sync();
		const unsubscribe = editor.playback.subscribe(sync);
		const unsubscribeSeek = editor.playback.onSeek(() =>
			playbackProbe.restartForSeek(),
		);
		return () => {
			unsubscribe();
			unsubscribeSeek();
			playbackProbe.stop({ reason: "dispose" });
		};
	}, [editor.playback, isExporting, playbackProbe, renderer]);

	useEffect(() => {
		runRenderRef.current = render;
	}, [render]);

	useEffect(() => {
		lastFrameRef.current = -1;
		lastSceneRef.current = null;
		scheduleRender("renderTree");
	}, [renderer, renderTree, scheduleRender]);

	useEffect(() => {
		if (isExporting) {
			pendingRenderRef.current = false;
			if (scheduledRenderRef.current !== null) {
				cancelAnimationFrame(scheduledRenderRef.current);
				scheduledRenderRef.current = null;
			}
			return;
		}
		lastFrameRef.current = -1;
		scheduleRender("exportComplete");
	}, [isExporting, scheduleRender]);

	useEffect(() => {
		const unsubscribeUpdate = editor.playback.onUpdate(() => {
			scheduleRender("playback");
		});
		const unsubscribeSeek = editor.playback.onSeek(() => {
			livePreviewRef.current?.pause();
			lastFrameRef.current = -1;
			scheduleRender("seek");
		});
		const unsubscribeState = editor.playback.subscribe(() => {
			if (!editor.playback.getIsPlaying()) livePreviewRef.current?.pause();
			lastFrameRef.current = -1;
			scheduleRender("playbackState");
		});
		scheduleRender("mount");
		return () => {
			unsubscribeUpdate();
			unsubscribeSeek();
			unsubscribeState();
		};
	}, [editor.playback, scheduleRender]);

	useEffect(
		() =>
			backgroundRemovalService.subscribeMaskInvalidation(({ kind }) => {
				lastFrameRef.current = -1;
				scheduleRender(`mask.${kind}`);
			}),
		[scheduleRender],
	);

	useEffect(() => {
		return () => {
			renderAttemptRef.current = null;
			if (preparingTimerRef.current !== null) {
				clearTimeout(preparingTimerRef.current);
				preparingTimerRef.current = null;
			}
			if (scheduledRenderRef.current !== null) {
				cancelAnimationFrame(scheduledRenderRef.current);
				scheduledRenderRef.current = null;
			}
		};
	}, []);

	useEffect(() => {
		const container = viewportRef.current;
		if (!container) return;

		let pendingZoomDelta = 0;
		let pendingPanDeltaX = 0;
		let pendingPanDeltaY = 0;
		let zoomRafId: ReturnType<typeof requestAnimationFrame> | null = null;
		let panRafId: ReturnType<typeof requestAnimationFrame> | null = null;

		const onWheel = (event: WheelEvent) => {
			const normalizedDeltaX = normalizeWheelDelta({
				delta: event.deltaX,
				deltaMode: event.deltaMode,
				pageSize: container.clientWidth,
			});
			const normalizedDeltaY = normalizeWheelDelta({
				delta: event.deltaY,
				deltaMode: event.deltaMode,
				pageSize: container.clientHeight,
			});
			const cameraMan = useCameraManStore.getState();
			const activeScene = editor.scenes.getActiveSceneOrNull();
			if (
				cameraMan.phase === "recording" &&
				cameraMan.sceneId === activeScene?.id &&
				cameraMan.current
			) {
				event.preventDefault();
				event.stopPropagation();
				const nextScale = Math.max(
					0.05,
					Math.min(
						20,
						cameraMan.current.scale * Math.exp(-normalizedDeltaY / 300),
					),
				);
				recordCameraManSample({
					time: editor.playback.getCurrentTime(),
					x: cameraMan.current.x,
					y: cameraMan.current.y,
					scale: nextScale,
				});
				return;
			}
			const isZoomGesture = event.ctrlKey || event.metaKey;
			if (isZoomGesture) {
				event.preventDefault();
				pendingZoomDelta += normalizedDeltaY;

				if (zoomRafId === null) {
					zoomRafId = requestAnimationFrame(() => {
						const cappedDelta =
							Math.sign(pendingZoomDelta) *
							Math.min(Math.abs(pendingZoomDelta), 30);
						const zoomFactor = Math.exp(-cappedDelta / 300);

						scaleZoom({ factor: zoomFactor });
						pendingZoomDelta = 0;
						zoomRafId = null;
					});
				}

				return;
			}

			if (!canPan) {
				return;
			}

			if (normalizedDeltaX === 0 && normalizedDeltaY === 0) {
				return;
			}

			event.preventDefault();
			pendingPanDeltaX += normalizedDeltaX;
			pendingPanDeltaY += normalizedDeltaY;

			if (panRafId === null) {
				panRafId = requestAnimationFrame(() => {
					panByScreenDelta({
						deltaX: pendingPanDeltaX,
						deltaY: pendingPanDeltaY,
					});
					pendingPanDeltaX = 0;
					pendingPanDeltaY = 0;
					panRafId = null;
				});
			}
		};

		let cameraPointerId: number | null = null;
		let lastCameraPointer = { x: 0, y: 0 };
		const onCameraPointerDown = (event: PointerEvent) => {
			const cameraMan = useCameraManStore.getState();
			const activeScene = editor.scenes.getActiveSceneOrNull();
			if (
				cameraMan.phase !== "recording" ||
				cameraMan.sceneId !== activeScene?.id
			) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			cameraPointerId = event.pointerId;
			lastCameraPointer = { x: event.clientX, y: event.clientY };
			container.setPointerCapture?.(event.pointerId);
		};
		const onCameraPointerMove = (event: PointerEvent) => {
			if (cameraPointerId !== event.pointerId) return;
			const cameraMan = useCameraManStore.getState();
			if (!cameraMan.current) return;
			event.preventDefault();
			event.stopPropagation();
			const deltaX = event.clientX - lastCameraPointer.x;
			const deltaY = event.clientY - lastCameraPointer.y;
			lastCameraPointer = { x: event.clientX, y: event.clientY };
			const cameraWidth = Math.max(1, activeProject.settings.canvasSize.width);
			const cameraHeight = Math.max(
				1,
				activeProject.settings.canvasSize.height,
			);
			const scale = Math.max(0.0001, viewport.getDisplayScale().x);
			recordCameraManSample({
				time: editor.playback.getCurrentTime(),
				x: cameraMan.current.x + deltaX / (scale * cameraWidth),
				y: cameraMan.current.y + deltaY / (scale * cameraHeight),
				scale: cameraMan.current.scale,
			});
		};
		const onCameraPointerUp = (event: PointerEvent) => {
			if (cameraPointerId !== event.pointerId) return;
			cameraPointerId = null;
			container.releasePointerCapture?.(event.pointerId);
		};

		container.addEventListener("wheel", onWheel, {
			capture: true,
			passive: false,
		});
		container.addEventListener("pointerdown", onCameraPointerDown, true);
		container.addEventListener("pointermove", onCameraPointerMove, true);
		container.addEventListener("pointerup", onCameraPointerUp, true);
		container.addEventListener("pointercancel", onCameraPointerUp, true);

		return () => {
			container.removeEventListener("wheel", onWheel, {
				capture: true,
			});
			container.removeEventListener("pointerdown", onCameraPointerDown, true);
			container.removeEventListener("pointermove", onCameraPointerMove, true);
			container.removeEventListener("pointerup", onCameraPointerUp, true);
			container.removeEventListener("pointercancel", onCameraPointerUp, true);
			if (zoomRafId !== null) {
				cancelAnimationFrame(zoomRafId);
			}
			if (panRafId !== null) {
				cancelAnimationFrame(panRafId);
			}
		};
	}, [
		activeProject.settings.canvasSize.height,
		activeProject.settings.canvasSize.width,
		canPan,
		editor.playback,
		editor.scenes,
		panByScreenDelta,
		scaleZoom,
		viewport,
	]);

	return (
		<Profiler id="PreviewCanvas" onRender={handleProfilerRender}>
			<PreviewViewportProvider value={viewport}>
				<div className="flex size-full min-h-0 min-w-0 flex-col">
					<div className="flex min-h-0 min-w-0 flex-1 p-2 pb-0">
						<ContextMenu>
							<ContextMenuTrigger asChild>
								<div
									ref={viewportRef}
									className="relative flex size-full min-h-0 min-w-0 items-center justify-center overflow-hidden"
								>
									<div
										ref={canvasMountRef}
										className="absolute block border"
										style={{
											left: viewport.sceneLeft,
											top: viewport.sceneTop,
											width: viewport.sceneWidth,
											height: viewport.sceneHeight,
											background:
												activeProject.settings.background.type === "blur"
													? "transparent"
													: activeProject?.settings.background.color,
											visibility: isExporting ? "hidden" : "visible",
										}}
									>
										<div
											className="pointer-events-none absolute inset-0 z-[1] overflow-hidden"
											style={{ display: isExporting ? "none" : undefined }}
										>
											<div
												ref={liveMountRef}
												style={{
													width: nativeWidth,
													height: nativeHeight,
													transformOrigin: "0 0",
													transform: `scale(${Math.max(0, viewport.sceneWidth - 2) / nativeWidth}, ${Math.max(0, viewport.sceneHeight - 2) / nativeHeight})`,
												}}
											/>
										</div>
									</div>
									{isExporting && (
										<div
											className="absolute flex items-center justify-center border bg-background/85 text-xs text-muted-foreground backdrop-blur-sm"
											style={{
												left: viewport.sceneLeft,
												top: viewport.sceneTop,
												width: viewport.sceneWidth,
												height: viewport.sceneHeight,
											}}
										>
											Exporting · preview paused
										</div>
									)}
									<PreviewOverlayLayer
										instances={overlayInstances}
										plane="under-interaction"
									/>
									<PreviewInteractionOverlay />
									<PreviewOverlayLayer
										instances={overlayInstances}
										plane="over-interaction"
									/>
									{!isExporting && (isPreparing || previewFailed) && (
										<div
											role={previewFailed ? "alert" : "status"}
											className="absolute bottom-3 left-1/2 z-10 flex max-w-full -translate-x-1/2 items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-xs text-foreground shadow-sm"
										>
											<span>
												{previewFailed
													? "Preview could not be rendered."
													: "Preparing preview…"}
											</span>
											{previewFailed && (
												<Button
													variant="outline"
													size="sm"
													onClick={() => {
														setPreviewRetry((value) => value + 1);
														lastFrameRef.current = -1;
														lastSceneRef.current = null;
														scheduleRender("retry");
													}}
												>
													Retry preview
												</Button>
											)}
										</div>
									)}
								</div>
							</ContextMenuTrigger>
							<PreviewContextMenu
								onToggleFullscreen={onToggleFullscreen}
								container={container}
								overlayControls={overlayControls}
								onOverlayVisibilityChange={onOverlayVisibilityChange}
							/>
						</ContextMenu>
					</div>
					<PreviewToolbar
						onToggleFullscreen={onToggleFullscreen}
						overlayControls={overlayControls}
						onOverlayVisibilityChange={onOverlayVisibilityChange}
					/>
				</div>
			</PreviewViewportProvider>
		</Profiler>
	);
}
