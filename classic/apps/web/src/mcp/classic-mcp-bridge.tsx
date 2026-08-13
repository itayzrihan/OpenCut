"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import type { EditorCore } from "@/core";
import { applyAiEditPlan } from "@/ai/edit-plan";
import {
	createTimelineToolDefinitions,
	createTimelineToolRuntime,
	createTimelineToolSessionState,
	type TimelineToolSessionState,
} from "@/ai/timeline-tools";
import { buildTimelineDocumentV2 } from "@/ai/timeline-document-v2";
import type { AiToolDefinition } from "@/ai/types";
import { backgroundRemovalService } from "@/services/background-removal";
import { mediaTimeToSeconds } from "@/wasm";

type BridgeStatus = "connecting" | "connected" | "unavailable";

type BridgeCommand = {
	id: string;
	sessionId: string;
	projectId: string;
	toolName: string;
	arguments: Record<string, unknown>;
	autoApply: boolean;
};

type BridgeCommandBatch = {
	commands: BridgeCommand[];
};

const bridgeCommandBatchSchema = z.object({
	commands: z.array(
		z.object({
			id: z.string(),
			sessionId: z.string(),
			projectId: z.string(),
			toolName: z.string(),
			arguments: z.record(z.string(), z.unknown()),
			autoApply: z.boolean(),
		}),
	),
});

const STATE_PUBLISH_INTERVAL_MS = 150;
const COMMAND_POLL_INTERVAL_MS = 750;
const HEARTBEAT_INTERVAL_MS = 2_000;

function sleep({ milliseconds }: { milliseconds: number }) {
	return new Promise<void>((resolve) => {
		window.setTimeout(resolve, milliseconds);
	});
}

function advertisedTool(tool: AiToolDefinition) {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		category: tool.category,
		keywords: tool.keywords ?? [],
		readOnly: tool.readOnly ?? false,
		idempotent: tool.idempotent ?? false,
		openWorld: tool.openWorld ?? false,
		risk: tool.risk,
	};
}

async function createBridgeToolRuntime({
	editor,
	toolName,
	sessionState,
}: {
	editor: EditorCore;
	toolName?: string;
	sessionState: TimelineToolSessionState;
}) {
	return createTimelineToolRuntime({
		editor,
		sessionState,
		options: {
			userRequest: toolName
				? `Authenticated OpenCut MCP requested capability ${toolName}`
				: "Expose the complete authenticated local OpenCut MCP capability inventory",
			includeLayerAccess: true,
			includeMediaAccess: true,
			includePreviewImage: true,
			includeAppControlAccess: true,
			includeNetworkAccess: false,
		},
	});
}

function buildSemanticUiSnapshot({
	lastActiveAtMs,
}: {
	lastActiveAtMs: number;
}) {
	const activeElement = document.activeElement;
	return {
		pathname: window.location.pathname,
		title: document.title,
		visibilityState: document.visibilityState,
		focused: document.hasFocus(),
		lastActiveAtMs,
		viewport: {
			width: window.innerWidth,
			height: window.innerHeight,
			devicePixelRatio: window.devicePixelRatio,
			scrollX: window.scrollX,
			scrollY: window.scrollY,
		},
		activeElement:
			activeElement instanceof HTMLElement
				? {
						tagName: activeElement.tagName.toLowerCase(),
						role: activeElement.getAttribute("role"),
						ariaLabel: activeElement.getAttribute("aria-label"),
						testId: activeElement.dataset.testid,
					}
				: null,
		dialogCount: document.querySelectorAll('[role="dialog"]').length,
		backgroundRemoval: backgroundRemovalService.getStatus(),
	};
}

export function ClassicMcpBridge({ editor }: { editor: EditorCore }) {
	const [status, setStatus] = useState<BridgeStatus>("connecting");
	const toolRegistrySignature = createTimelineToolDefinitions()
		.map((tool) => tool.name)
		.join("|");

	useEffect(() => {
		let disposed = false;
		const sessionId = crypto.randomUUID();
		let revision = 1;
		let timelineDirty = true;
		let cachedTimeline: unknown = null;
		let tools: ReturnType<typeof advertisedTool>[] = [];
		let publishTimer: number | null = null;
		let publishing = false;
		let publishAgain = false;
		let lastActiveAtMs =
			document.visibilityState === "visible" ? Date.now() : 0;
		const toolSessionState = createTimelineToolSessionState();

		const readTimeline = () => {
			if (!timelineDirty && cachedTimeline) return cachedTimeline;
			const project = editor.project.getActiveOrNull();
			const scene = editor.scenes.getActiveSceneOrNull();
			if (!project || !scene) return null;
			const document = buildTimelineDocumentV2({ project, scene });
			cachedTimeline = document.valid
				? JSON.parse(document.formattedText)
				: {
						unavailable: true,
						diagnostics: document.diagnostics,
					};
			timelineDirty = false;
			return cachedTimeline;
		};

		const publishState = async () => {
			if (disposed) return;
			if (publishing) {
				publishAgain = true;
				return;
			}
			publishing = true;
			try {
				const project = editor.project.getActiveOrNull();
				const scene = editor.scenes.getActiveSceneOrNull();
				if (!project || !scene) return;
				const currentTime = editor.playback.getCurrentTime();
				const response = await fetch("/api/mcp-bridge/state", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					cache: "no-store",
					body: JSON.stringify({
						sessionId,
						projectId: project.metadata.id,
						projectName: project.metadata.name,
						revision,
						dirty: editor.save.getIsDirty(),
						playback: {
							playing: editor.playback.getIsPlaying(),
							positionTicks: currentTime,
							positionSeconds: mediaTimeToSeconds({ time: currentTime }),
							durationTicks: editor.timeline.getTotalDuration(),
							durationSeconds: mediaTimeToSeconds({
								time: editor.timeline.getTotalDuration(),
							}),
							volume: editor.playback.getVolume(),
							muted: editor.playback.isMuted(),
							sceneId: scene.id,
							sceneName: scene.name,
						},
						timeline: readTimeline(),
						selection: editor.selection.getSnapshot(),
						backgroundRemoval: backgroundRemovalService.getStatus(),
						ui: buildSemanticUiSnapshot({ lastActiveAtMs }),
						tools,
					}),
				});
				if (!response.ok) {
					throw new Error(`MCP bridge returned ${response.status}`);
				}
				if (!disposed) setStatus("connected");
			} catch {
				if (!disposed) setStatus("unavailable");
			} finally {
				publishing = false;
				if (publishAgain && !disposed) {
					publishAgain = false;
					void publishState();
				}
			}
		};

		const schedulePublish = () => {
			if (disposed || publishTimer !== null) return;
			publishTimer = window.setTimeout(() => {
				publishTimer = null;
				void publishState();
			}, STATE_PUBLISH_INTERVAL_MS);
		};

		const markDocumentChanged = () => {
			revision += 1;
			timelineDirty = true;
			schedulePublish();
		};
		const markStateChanged = () => {
			revision += 1;
			schedulePublish();
		};
		const markTabActivityChanged = () => {
			if (document.visibilityState === "visible" || document.hasFocus()) {
				lastActiveAtMs = Date.now();
			}
			schedulePublish();
		};

		const executeCommand = async (command: BridgeCommand) => {
			let output: unknown = null;
			let applied = false;
			let error: string | undefined;
			try {
				const project = editor.project.getActiveOrNull();
				if (!project || project.metadata.id !== command.projectId) {
					throw new Error(
						`Project ${command.projectId} is not active in this browser`,
					);
				}
				const runtime = await createBridgeToolRuntime({
					editor,
					toolName: command.toolName,
					sessionState: toolSessionState,
				});
				const tool = runtime.tools.find(
					(candidate) => candidate.name === command.toolName,
				);
				if (!tool) {
					throw new Error(
						`Capability ${command.toolName} is unavailable in the browser`,
					);
				}
				output = await runtime.executeTool({
					id: command.id,
					name: command.toolName,
					arguments: command.arguments ?? {},
				});
				const plan = runtime.getSourceEditPlan();
				if (plan && command.autoApply) {
					applyAiEditPlan({ editor, plan });
					applied = true;
				} else if (!tool.readOnly && !plan) {
					applied = true;
				}
				if (applied) {
					revision += 1;
					timelineDirty = true;
				}
			} catch (cause) {
				error =
					cause instanceof Error ? cause.message : "Browser capability failed";
			}

			await fetch(`/api/mcp-bridge/results/${encodeURIComponent(sessionId)}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				cache: "no-store",
				body: JSON.stringify({
					commandId: command.id,
					ok: error === undefined,
					output: output ?? null,
					error,
					applied,
					revision,
				}),
			});
			schedulePublish();
		};

		const pollCommands = async () => {
			while (!disposed) {
				try {
					const response = await fetch(
						`/api/mcp-bridge/commands/${encodeURIComponent(sessionId)}`,
						{ cache: "no-store" },
					);
					if (!response.ok) {
						throw new Error(`MCP bridge returned ${response.status}`);
					}
					const batch: BridgeCommandBatch = bridgeCommandBatchSchema.parse(
						await response.json(),
					);
					for (const command of batch.commands ?? []) {
						if (disposed) return;
						await executeCommand(command);
					}
				} catch {
					if (!disposed) setStatus("unavailable");
				}
				await sleep({ milliseconds: COMMAND_POLL_INTERVAL_MS });
			}
		};

		const unsubscribers = [
			editor.timeline.subscribe(markDocumentChanged),
			editor.scenes.subscribe(markDocumentChanged),
			editor.project.subscribe(markDocumentChanged),
			editor.media.subscribe(markDocumentChanged),
			editor.selection.subscribe(markStateChanged),
			editor.playback.subscribe(schedulePublish),
			// Playback's frame clock runs up to 60 times per second. Publishing the
			// full semantic timeline on every frame competes with local media range
			// reads and preview rendering. Play/pause/seek state publishes promptly;
			// the heartbeat refreshes an advancing playhead while it is running.
			backgroundRemovalService.subscribe(schedulePublish),
		];
		const heartbeat = window.setInterval(
			schedulePublish,
			HEARTBEAT_INTERVAL_MS,
		);
		window.addEventListener("focus", markTabActivityChanged);
		window.addEventListener("blur", markTabActivityChanged);
		document.addEventListener("visibilitychange", markTabActivityChanged);

		void createBridgeToolRuntime({ editor, sessionState: toolSessionState })
			.then((runtime) => {
				tools = runtime.tools.map(advertisedTool);
			})
			.catch(() => {
				tools = [];
			})
			.finally(() => {
				void publishState();
				void pollCommands();
			});

		return () => {
			disposed = true;
			for (const unsubscribe of unsubscribers) unsubscribe();
			window.removeEventListener("focus", markTabActivityChanged);
			window.removeEventListener("blur", markTabActivityChanged);
			document.removeEventListener("visibilitychange", markTabActivityChanged);
			window.clearInterval(heartbeat);
			if (publishTimer !== null) window.clearTimeout(publishTimer);
			void fetch(`/api/mcp-bridge/session/${encodeURIComponent(sessionId)}`, {
				method: "DELETE",
				cache: "no-store",
				keepalive: true,
			});
		};
	}, [editor, toolRegistrySignature]);

	return (
		<div
			data-testid="mcp-connection-status"
			data-status={status}
			className="pointer-events-none fixed right-3 bottom-3 z-[100] rounded-full border border-white/10 bg-black/75 px-2.5 py-1 text-[10px] text-white/80 shadow-sm backdrop-blur"
		>
			<span
				className={`mr-1.5 inline-block size-1.5 rounded-full ${
					status === "connected"
						? "bg-emerald-400"
						: status === "connecting"
							? "bg-amber-400"
							: "bg-red-400"
				}`}
			/>
			{status === "connected"
				? "MCP connected"
				: status === "connecting"
					? "MCP connecting"
					: "MCP unavailable"}
		</div>
	);
}
