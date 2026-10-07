import { z } from "zod";
import { toast } from "sonner";
import type { EditorCore } from "@/core";
import {
	requestSmartTakePlan,
	smartTakePlanSchema,
	type SmartTakeCheckpoint,
} from "./smart-takes-plan";

// Transport orchestration only. The canonical Rust session owns every edit,
// source validation, revision check, transcript rebuild and history boundary.
const tasks = new WeakMap<EditorCore, SmartTakesTask>();
// Serialized field order can change on save/reopen without changing the source.
function sourceKey(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
				)
			: item,
	);
}
const checkpointSchema = z.object({
	source: z.string(),
	checkpoint: z.object({
		analysis: z.string().optional(),
		draft: smartTakePlanSchema.optional(),
		plan: smartTakePlanSchema.optional(),
	}),
});
type Status = {
	status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
	requestId?: string;
	projectId?: string;
	sceneId?: string;
	stage?: string;
	error?: string;
	wordCount?: number;
	groupCount?: number;
	hasCheckpoint?: boolean;
};
export function getSmartTakesTask(editor: EditorCore): SmartTakesTask {
	let task = tasks.get(editor);
	if (!task) {
		task = new SmartTakesTask(editor);
		tasks.set(editor, task);
	}
	return task;
}
export class SmartTakesTask {
	private state: Status = { status: "idle" };
	private listeners = new Set<() => void>();
	private controller: AbortController | null = null;
	private account: string | undefined;
	private checkpoint: SmartTakeCheckpoint = {};
	private words: ReturnType<
		EditorCore["command"]["prepareSmartTakes"]
	>["words"] = [];
	private elementIds: string[] = [];
	constructor(private editor: EditorCore) {}
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	getSnapshot = () => this.state;
	read(includePlan = false) {
		if (
			this.account !== window.__opencutAccountId ||
			this.state.projectId !==
				this.editor.project.getActiveOrNull()?.metadata.id ||
			this.state.sceneId !== this.editor.scenes.getActiveSceneOrNull()?.id
		)
			return { status: "idle" };
		return includePlan
			? { ...this.state, checkpoint: this.checkpoint, words: this.words }
			: this.state;
	}
	private update(change: Partial<Status>) {
		this.state = { ...this.state, ...change };
		for (const listener of this.listeners) listener();
	}
	cancel = () => {
		this.controller?.abort();
		return this.state;
	};
	start({
		elementIds,
		requestId,
	}: {
		elementIds: string[];
		requestId: string;
	}) {
		const projectId = this.editor.project.getActive().metadata.id;
		const scene = this.editor.scenes.getActiveScene();
		const account = window.__opencutAccountId;
		if (!account) throw new Error("Sign in and connect ChatGPT first");
		if (this.editor.project.getSessionReadOnlyReason())
			throw new Error("Take ownership of the project before analyzing takes");
		if (
			this.account === account &&
			this.state.projectId === projectId &&
			this.state.requestId === requestId
		) {
			if (
				JSON.stringify(this.elementIds) !== JSON.stringify(elementIds) ||
				this.state.sceneId !== scene.id
			)
				throw new Error(
					"Smart takes requestId was reused with different inputs",
				);
			return this.state;
		}
		if (this.controller) throw new Error("Smart takes is already running");
		const prepared = this.editor.command.prepareSmartTakes(elementIds);
		const source = sourceKey({ scene, elementIds, words: prepared.words });
		const key = `opencut:smart-takes:v1:${account}:${projectId}:${scene.id}`;
		let checkpoint: SmartTakeCheckpoint = {};
		try {
			const saved = checkpointSchema.safeParse(
				JSON.parse(sessionStorage.getItem(key) ?? "null"),
			);
			if (saved.success && sourceKey(JSON.parse(saved.data.source)) === source)
				checkpoint = saved.data.checkpoint;
		} catch {
			/* Storage is optional; analysis remains usable without it. */
		}
		this.account = account;
		this.elementIds = [...elementIds];
		this.checkpoint = checkpoint;
		this.words = prepared.words;
		this.state = {
			status: "running",
			requestId,
			projectId,
			sceneId: scene.id,
			stage: "Preparing transcript",
			wordCount: prepared.words.length,
			hasCheckpoint: !!checkpoint.analysis || !!checkpoint.plan,
		};
		const controller = new AbortController();
		this.controller = controller;
		this.update({});
		void this.run({
			prepared,
			controller,
			checkpoint,
			save: (next) => {
				this.checkpoint = next;
				try {
					sessionStorage.setItem(
						key,
						JSON.stringify({ source, checkpoint: next }),
					);
				} catch {
					/* Quota/privacy modes must not fail the edit. */
				}
				this.update({ hasCheckpoint: true });
			},
		});
		return this.state;
	}
	private async run({
		prepared,
		controller,
		checkpoint,
		save,
	}: {
		prepared: ReturnType<EditorCore["command"]["prepareSmartTakes"]>;
		controller: AbortController;
		checkpoint: SmartTakeCheckpoint;
		save: (value: SmartTakeCheckpoint) => void;
	}) {
		try {
			const plan = await requestSmartTakePlan({
				words: prepared.words,
				signal: controller.signal,
				checkpoint,
				onCheckpoint: save,
				onStage: (stage) => this.update({ stage }),
			});
			controller.signal.throwIfAborted();
			this.update({ stage: "Applying take plan" });
			prepared.apply(plan);
			this.update({ status: "succeeded", groupCount: plan.groups.length });
			toast.success("Smart takes assembled", {
				description: `${plan.groups.length} story groups. Right-click a take to choose an alternative.`,
				action: { label: "Undo", onClick: () => this.editor.command.undo() },
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.update({
				status: controller.signal.aborted ? "cancelled" : "failed",
				error: message,
			});
			if (!controller.signal.aborted) {
				console.error("Smart takes failed", {
					stage: this.state.stage,
					message,
				});
				toast.error("Could not assemble takes", {
					description: `${this.state.stage}: ${message}`,
					duration: Infinity,
					closeButton: true,
				});
			}
		} finally {
			this.controller = null;
		}
	}
}
