"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Send, X } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useEditor } from "@/editor/use-editor";
import { useTimelineStore } from "@/timeline/timeline-store";
import { getSelectedTimelineRange } from "@/timeline/range-selection";
import {
	buildTimelineContextIndex,
	getLayersInRange,
} from "@/ai/timeline-context";
import { runAiAgent } from "@/ai/client-agent";
import {
	applyAiEditPlan,
	extractAiEditPlanFromText,
	validateAiEditPlan,
} from "@/ai/edit-plan";
import type { AiEditPlan } from "@/ai/types";
import {
	buildAiSystemPrompt,
	buildTimelineContextPrompt,
	createTimelineToolRuntime,
} from "@/ai/timeline-tools";
import { AiPlanReview } from "./ai-plan-review";
import { useAiOAuthStatus } from "./use-ai-oauth-status";

function readPlanHeading({ text }: { text: string }): {
	title?: string;
	summary?: string;
} | null {
	const value = extractAiEditPlanFromText(text);
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	return {
		title: typeof record.title === "string" ? record.title : undefined,
		summary: typeof record.summary === "string" ? record.summary : undefined,
	};
}

export function AiRangeDialog() {
	const editor = useEditor();
	const rangeSelection = useTimelineStore((state) => state.aiRangeSelection);
	const setRangePromptOpen = useTimelineStore(
		(state) => state.setRangePromptOpen,
	);
	const cancelRangeSelection = useTimelineStore(
		(state) => state.cancelRangeSelection,
	);
	const range = getSelectedTimelineRange(rangeSelection);
	const { status, login } = useAiOAuthStatus();
	const [mode, setMode] = useState<"free" | "layers">("free");
	const [freePrompt, setFreePrompt] = useState("");
	const [layerPrompts, setLayerPrompts] = useState<Record<string, string>>({});
	const [isRunning, setIsRunning] = useState(false);
	const [agentStatus, setAgentStatus] = useState("");
	const [pendingPlan, setPendingPlan] = useState<AiEditPlan | null>(null);
	const [planErrors, setPlanErrors] = useState<string[]>([]);
	const [isApplying, setIsApplying] = useState(false);
	const abortControllerRef = useRef<AbortController | null>(null);

	useEffect(() => {
		return () => abortControllerRef.current?.abort();
	}, []);

	const layersInRange = useMemo(() => {
		const scene = editor.scenes.getActiveSceneOrNull();
		if (!scene || !range) return [];
		const index = buildTimelineContextIndex({
			tracks: scene.tracks,
			mediaAssets: editor.media.getAssets(),
		});
		return getLayersInRange({ index, range });
	}, [editor, range]);

	const open = rangeSelection.isPromptOpen && !!range;
	const close = () => {
		abortControllerRef.current?.abort();
		setRangePromptOpen(false);
		setPendingPlan(null);
		setPlanErrors([]);
		setAgentStatus("");
	};

	const handleSubmit = async () => {
		if (!range || isRunning) return;
		if (!status.authenticated) {
			login();
			return;
		}
		const scene = editor.scenes.getActiveSceneOrNull();
		if (!scene) return;

		const prompt =
			mode === "free"
				? freePrompt.trim()
				: layersInRange
						.map((layer) => {
							const value = layerPrompts[layer.id]?.trim();
							return value ? `${layer.name} (${layer.id}): ${value}` : "";
						})
						.filter(Boolean)
						.join("\n");
		if (!prompt) return;

		setIsRunning(true);
		setPendingPlan(null);
		setPlanErrors([]);
		const controller = new AbortController();
		abortControllerRef.current = controller;
		try {
			const toolRuntime = await createTimelineToolRuntime({
				editor,
				options: { range, includePreviewImage: true, userRequest: prompt },
			});
			const context = buildTimelineContextPrompt({
				editor,
				range,
				includePlayheadTime: true,
				includeActiveRange: true,
				includeBookmarks: true,
				includeCaptions: true,
			});
			const result = await runAiAgent({
				messages: [
					{
						role: "system",
						content: buildAiSystemPrompt({ userRequest: prompt }),
					},
					{
						role: "user",
						content: [
							context,
							"Timeline range editing is active. Keep every edit inside this range.",
							mode === "layers"
								? "Per-layer instructions:\n" + prompt
								: "User request:\n" + prompt,
						].join("\n\n"),
					},
				],
				tools: toolRuntime.tools,
				executeTool: toolRuntime.executeTool,
				signal: controller.signal,
				preferDirectPlan: false,
				onStep: setAgentStatus,
				completionGuard: ({ editPlan }) => {
					const errors = toolRuntime.getCompletionErrors(
						toolRuntime.getSourceEditPlan() ?? editPlan,
					);
					return errors.length > 0 ? errors.join("\n") : null;
				},
			});
			const sourcePlan = toolRuntime.getSourceEditPlan();
			const heading = readPlanHeading({ text: result.text });
			const planValue = sourcePlan
				? {
						...sourcePlan,
						title: heading?.title ?? sourcePlan.title,
						summary: heading?.summary ?? sourcePlan.summary,
					}
				: result.editPlan;
			const validation = validateAiEditPlan({
				value: planValue,
				tracks: scene.tracks,
				range,
				mediaAssets: editor.media.getAssets(),
				scenes: editor.scenes.getScenes(),
				activeSceneId: scene.id,
				projectSettings: editor.project.getActive().settings,
				exportState: editor.project.getExportState(),
				transcriptionState: editor.transcription.getState(),
			});
			setPendingPlan(validation.plan);
			setPlanErrors([
				...validation.errors,
				...toolRuntime.getCompletionErrors(validation.plan),
			]);
			if (!validation.plan) {
				toast.error(result.error ?? "The AI did not return a valid edit plan");
			}
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				toast.info("AI request cancelled");
			} else {
				toast.error(
					error instanceof Error ? error.message : "AI request failed",
				);
			}
		} finally {
			if (abortControllerRef.current === controller) {
				abortControllerRef.current = null;
			}
			setIsRunning(false);
			setAgentStatus("");
		}
	};

	const handleCancel = () => abortControllerRef.current?.abort();

	const handleApply = () => {
		if (!pendingPlan || planErrors.length > 0) return;
		const scene = editor.scenes.getActiveSceneOrNull();
		if (!scene || !range) {
			toast.error("The active timeline range is no longer available");
			return;
		}
		const validation = validateAiEditPlan({
			value: pendingPlan,
			tracks: scene.tracks,
			range,
			mediaAssets: editor.media.getAssets(),
			scenes: editor.scenes.getScenes(),
			activeSceneId: scene.id,
			projectSettings: editor.project.getActive().settings,
			exportState: editor.project.getExportState(),
			transcriptionState: editor.transcription.getState(),
		});
		setPendingPlan(validation.plan);
		setPlanErrors(validation.errors);
		if (!validation.plan || validation.errors.length > 0) {
			toast.error("The timeline changed. Review the AI edit again.");
			return;
		}
		setIsApplying(true);
		try {
			applyAiEditPlan({ editor, plan: validation.plan, range });
			toast.success("AI range edit applied");
			cancelRangeSelection();
			setPendingPlan(null);
			setPlanErrors([]);
			setAgentStatus("");
			setFreePrompt("");
			setLayerPrompts({});
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to apply edits",
			);
		} finally {
			setIsApplying(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && close()}>
			<DialogContent className="flex max-h-[86vh] max-w-3xl grid-rows-none flex-col overflow-hidden p-0">
				<DialogHeader className="shrink-0">
					<DialogTitle>AI range edit</DialogTitle>
					<DialogDescription>
						{range ? `${range.startTime} - ${range.endTime} ticks` : ""}
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="min-h-0 flex-1 overflow-y-auto">
					<Tabs
						value={mode}
						onValueChange={(value) => {
							if (value === "free" || value === "layers") {
								setMode(value);
							}
						}}
					>
						<TabsList>
							<TabsTrigger value="free">Free form</TabsTrigger>
							<TabsTrigger value="layers">Per layer</TabsTrigger>
						</TabsList>
						<TabsContent value="free" className="mt-3 px-0">
							<Textarea
								value={freePrompt}
								onChange={(event) => setFreePrompt(event.target.value)}
								placeholder="Describe what should happen in this range"
								className="min-h-36"
							/>
						</TabsContent>
						<TabsContent value="layers" className="mt-3 px-0">
							<div className="flex flex-col gap-2">
								{layersInRange.length === 0 ? (
									<div className="text-muted-foreground rounded-sm border p-3 text-sm">
										No layers overlap this range.
									</div>
								) : (
									layersInRange.map((layer) => (
										<div
											key={layer.id}
											className="grid gap-2 rounded-sm border p-3"
										>
											<div className="flex items-center justify-between gap-3">
												<div className="min-w-0 text-sm font-medium">
													{layer.name}
												</div>
												<div className="text-muted-foreground shrink-0 text-xs">
													{layer.type}
												</div>
											</div>
											<Textarea
												value={layerPrompts[layer.id] ?? ""}
												onChange={(event) =>
													setLayerPrompts((previous) => ({
														...previous,
														[layer.id]: event.target.value,
													}))
												}
												placeholder="Describe the edit for this layer"
												className="min-h-20"
											/>
										</div>
									))
								)}
							</div>
						</TabsContent>
					</Tabs>

					{status.error && !status.authenticated && (
						<div className="border-destructive/30 bg-destructive/10 text-destructive rounded-sm border p-3 text-xs">
							{status.error}
						</div>
					)}

					{agentStatus && (
						<div className="text-muted-foreground text-xs">{agentStatus}</div>
					)}

					<AiPlanReview
						plan={pendingPlan}
						errors={planErrors}
						isApplying={isApplying}
						onApply={handleApply}
						onDiscard={() => setPendingPlan(null)}
					/>
				</DialogBody>
				<DialogFooter className="shrink-0">
					<Button variant="outline" onClick={close}>
						Close
					</Button>
					<Button onClick={isRunning ? handleCancel : handleSubmit}>
						{isRunning ? <X className="size-4" /> : <Send className="size-4" />}
						{isRunning ? "Cancel" : "Send"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
