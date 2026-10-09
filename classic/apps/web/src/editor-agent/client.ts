import type { EditorCore } from "@/core";
import type {
	EditingAgentSnapshot,
	EditingAgentProviderRound,
} from "@/core/agent-protocol";
import { mediaTime } from "@/wasm/media-time";
import { type AgentStreamEvent } from "./stream";
import { requestAgentResponse } from "./transport";
import { z } from "zod";
import { knowledgeRequest } from "./knowledge-client";
import { performHostEffect } from "./host-effects";
import { performRenderEffect } from "./render-effects";

export interface AgentConnection {
	connected: boolean;
	sharing: boolean;
	connecting: boolean;
	identity: { name?: string; email?: string } | null;
	error: string | null;
	usageUrl: string;
}
function isTerminalRun(
	snapshot: EditingAgentSnapshot | null | undefined,
): boolean {
	return snapshot?.phase === "completed" || snapshot?.phase === "failed";
}
export interface AgentModel {
	id: string;
	name: string;
}
export const connectionSchemas = {
	status: z.object({
		connected: z.boolean(),
		sharing: z.boolean(),
		connecting: z.boolean(),
		identity: z
			.object({ name: z.string().optional(), email: z.string().optional() })
			.nullable(),
		error: z.string().nullable(),
		usageUrl: z.string().url(),
	}),
	models: z.object({
		models: z
			.array(
				z.object({ id: z.string().min(1).max(100), name: z.string().max(200) }),
			)
			.max(200),
	}),
	signIn: z.object({
		authorizationUrl: z
			.string()
			.url()
			.refine(
				(url) => new URL(url).origin === "https://auth.openai.com",
				"Invalid ChatGPT authorization destination",
			),
		expiresAt: z.number().finite(),
	}),
	disconnect: z.object({ revocationConfirmed: z.boolean() }),
};
export type AgentClientEvent =
	| { type: "artifacts"; images: string[]; artifactIds: string[] }
	| { type: "export"; url: string; filename: string; artifactId: string }
	| {
			type: "conversation";
			entries: import("@/core/agent-protocol").EditingConversationEntry[];
	  }
	| { type: "round"; review: boolean }
	| AgentStreamEvent
	| { type: "activities"; activities: EditingAgentProviderRound["activities"] }
	| { type: "snapshot"; snapshot: EditingAgentSnapshot | null }
	| {
			type: "review";
			summary: string;
			issues: string[];
			images: string[];
			artifactIds: string[];
	  }
	| { type: "status"; text: string };

function accountId() {
	return window.__opencutAccountId ?? "local";
}

export async function connectionRequest<T>({
	operation,
	signal,
	schema,
}: {
	operation?: "signIn" | "disconnect" | "models";
	signal?: AbortSignal;
	schema: z.ZodType<T>;
}): Promise<T> {
	const account = accountId();
	const response = await fetch("/api/editor-agent/connection", {
		method: operation ? "POST" : "GET",
		credentials: "same-origin",
		cache: "no-store",
		signal,
		headers: {
			"Content-Type": "application/json",
			"X-OpenCut-Account": account,
		},
		...(operation ? { body: JSON.stringify({ operation }) } : {}),
	});
	if (accountId() !== account) throw new Error("The active account changed");
	const value: unknown = await response.json();
	if (!response.ok)
		throw new Error(
			z.object({ error: z.string() }).safeParse(value).data?.error ??
				"Connection request failed",
		);
	return schema.parse(value);
}

/** Host IO only. Planning, capability dispatch, context and completion gates
 * remain in the Rust harness. One controller owns the active editor request. */
export class EditorAgentClient {
	private readonly editor: EditorCore;
	private readonly emit: (event: AgentClientEvent) => void;
	private controller: AbortController | null = null;
	private operation: Promise<void> | null = null;
	private generation = 0;
	private disposed = false;
	private readonly account = accountId();
	private readonly project: string;
	private readonly images = new Set<string>();
	constructor({
		editor,
		emit,
	}: {
		editor: EditorCore;
		emit: (event: AgentClientEvent) => void;
	}) {
		this.editor = editor;
		this.emit = (event) => {
			if (this.disposed) return;
			this.assertScope();
			let archive:
				| import("@/core/agent-protocol").EditingConversationArchive
				| null = null;
			if (
				[
					"round",
					"text",
					"summary",
					"status",
					"activities",
					"review",
					"export",
					"artifacts",
				].includes(event.type)
			) {
				if (event.type === "artifacts")
					archive = editor.command.applyEditingConversation({
						type: "artifacts",
						artifactIds: event.artifactIds,
					});
				else if (event.type === "review")
					archive = editor.command.applyEditingConversation({
						type: "review",
						summary: event.summary,
						issues: event.issues,
						artifactIds: event.artifactIds,
					});
				else if (event.type === "export")
					archive = editor.command.applyEditingConversation({
						type: "export",
						artifactId: event.artifactId,
						filename: event.filename,
					});
				else if (event.type === "round")
					archive = editor.command.applyEditingConversation({
						type: "round",
						review: event.review,
					});
				else if (event.type === "activities")
					archive = editor.command.applyEditingConversation({
						type: "activities",
						activities: event.activities,
					});
				else if (
					event.type === "text" ||
					event.type === "summary" ||
					event.type === "status"
				)
					archive = editor.command.applyEditingConversation({
						type: event.type,
						text: event.text,
					});
			} else if (
				event.type === "snapshot" &&
				event.snapshot &&
				(event.snapshot?.phase === "paused" || isTerminalRun(event.snapshot))
			) {
				archive = editor.command.applyEditingConversation({
					type: event.snapshot.phase === "paused" ? "pause" : "close",
				});
			}
			if (archive) emit({ type: "conversation", entries: archive.entries });
			emit(event);
		};
		const id = editor.project.getActiveOrNull()?.metadata.id;
		if (!id) throw new Error("Open a project before starting the agent");
		this.project = id;
	}
	private assertScope() {
		if (
			accountId() !== this.account ||
			this.editor.project.getActiveOrNull()?.metadata.id !== this.project
		)
			throw new Error("The agent's account or project changed");
	}
	private snapshot() {
		this.assertScope();
		const snapshot = this.editor.command.getEditingAgentSnapshot();
		this.emit({ type: "snapshot", snapshot });
		return snapshot;
	}
	pause() {
		this.generation += 1;
		const snapshot = this.editor.command.getEditingAgentSnapshot();
		const wasActive = !!snapshot && !isTerminalRun(snapshot);
		this.interrupt();
		// Unmounting an idle panel is not an edit. In particular, a background
		// handoff has already released this viewer's persistence authority.
		if (wasActive && this.editor.command.hasAtomicSessionStorage()) {
			void this.persist().catch((error) =>
				this.emit({
					type: "status",
					text:
						error instanceof Error
							? error.message
							: "The paused run could not be saved",
				}),
			);
		}
	}
	private interrupt() {
		this.controller?.abort();
		this.assertScope();
		if (
			!isTerminalRun(this.editor.command.getEditingAgentSnapshot()) &&
			this.editor.command.getEditingAgentSnapshot()
		)
			this.editor.command.executeEditingAgentCommand({ type: "pause" });
		this.snapshot();
	}
	dispose() {
		try {
			this.pause();
		} catch {
			this.controller?.abort();
		}
		this.disposed = true;
		for (const url of this.images) URL.revokeObjectURL(url);
		this.images.clear();
	}
	async run({
		text,
		model,
		attachments,
	}: {
		text?: string;
		model: string;
		attachments?: import("@/core/agent-protocol").EditingInputAttachment[];
	}) {
		this.assertScope();
		const generation = ++this.generation;
		if (this.operation) {
			this.interrupt();
			await this.operation.catch(() => {});
		}
		if (generation !== this.generation) return;
		const controller = new AbortController();
		this.controller = controller;
		const execute = async () => {
			if (text?.trim()) {
				const archive = this.editor.command.applyEditingConversation({
					type: "user",
					text,
					...(attachments?.length ? { attachments } : {}),
				});
				this.emit({ type: "conversation", entries: archive.entries });
			}
			let snapshot = this.snapshot();
			if (!snapshot || isTerminalRun(snapshot)) {
				if (!text?.trim())
					throw new Error("Describe the edit to start a new run");
				snapshot = await this.editor.command.startEditingAgent({
					runId: crypto.randomUUID(),
					request: text,
				});
			} else {
				// A lost response may already have committed. Reconcile the
				// exact Rust-generated request before allowing resume or writes.
				await this.reconcileHost(controller.signal);
				if (text?.trim())
					this.editor.command.executeEditingAgentCommand({
						type: "steer",
						text,
					});
				if (snapshot.phase === "paused")
					this.editor.command.executeEditingAgentCommand({
						type: "resume",
						scope: snapshot.scope,
					});
			}
			this.snapshot();
			for (;;) {
				if (attachments) {
					this.editor.command.setEditingInputAttachments(attachments);
					attachments = undefined;
				}
				controller.signal.throwIfAborted();
				this.assertScope();
				const knowledgeSnapshot = this.editor.command.getEditingAgentSnapshot();
				const knowledge = await knowledgeRequest({
					projectId: this.project,
					request: {
						type: "context",
						query: [
							knowledgeSnapshot?.request,
							...(knowledgeSnapshot?.steering ?? []),
						]
							.join("\n")
							.slice(-4000),
						maxBytes: 24_000,
					},
					signal: controller.signal,
				});
				controller.signal.throwIfAborted();
				this.assertScope();
				this.editor.command.loadEditingAgentKnowledge(knowledge.data);
				const request = this.editor.command.prepareEditingAgentRequest(model);
				this.emit({ type: "round", review: false });
				const response = await this.respond({
					body: request.body,
					signal: controller.signal,
				});
				controller.signal.throwIfAborted();
				this.assertScope();
				let round = this.editor.command.applyEditingAgentResponse({
					epoch: request.epoch,
					response,
				});
				this.emit({ type: "activities", activities: round.activities });
				await this.persist();
				if (round.pendingHost && round.phase !== "paused") {
					const settled = await this.reconcileHost(controller.signal);
					if (settled) round = settled;
				}
				this.snapshot();
				if (round.message) this.emit({ type: "status", text: round.message });
				if (
					round.phase === "completed" ||
					round.phase === "failed" ||
					round.phase === "paused"
				) {
					await this.persist();
					break;
				}
				if (round.needsVerification)
					await this.review({ model, signal: controller.signal });
			}
		};
		const operation = execute();
		this.operation = operation;
		try {
			await operation;
		} catch (error) {
			if (!controller.signal.aborted) {
				this.pause();
				throw error;
			}
		} finally {
			if (this.controller === controller) {
				if (controller.signal.aborted) {
					try {
						this.interrupt();
					} catch {
						/* The editor may have closed while loading. */
					}
				}
				this.controller = null;
				this.operation = null;
			}
		}
	}
	private async reconcileHost(
		signal: AbortSignal,
	): Promise<EditingAgentProviderRound | null> {
		signal.throwIfAborted();
		this.assertScope();
		const effect = this.editor.command.getEditingAgentHostEffect();
		if (!effect) return null;
		if (effect.projectId !== this.project)
			throw new Error("Host effect targets another project");
		await this.persist();
		signal.throwIfAborted();
		this.emit({
			type: "status",
			text: "Applying the registered host operation…",
		});
		const exports: Array<{ blob: Blob; filename: string; artifactId: string }> =
			[];
		const result =
			effect.adapter === "hyperframesAuthoring" ||
			effect.adapter === "editorRender"
				? await performRenderEffect({
						effect,
						editor: this.editor,
						accountId: this.account,
						signal,
						onExport: (value) => exports.push(value),
					})
				: await performHostEffect({
						effect,
						accountId: this.account,
						signal,
						activeProjectId: () =>
							this.editor.project.getActiveOrNull()?.metadata.id,
						currentRevision: () => this.editor.command.getCanonicalRevision(),
						storeScreenshot: (capture) =>
							this.editor.command.storeEditingAgentScreenshot(capture),
						storeImage: (image) =>
							this.editor.command.storeEditingAgentImage(image),
					});
		signal.throwIfAborted();
		this.assertScope();
		const round = this.editor.command.settleEditingAgentHostEffect({
			effectId: effect.id,
			result,
		});
		if (round.activities.some((activity) => activity.ok)) {
			for (const value of exports) {
				const url = URL.createObjectURL(value.blob);
				this.images.add(url);
				this.emit({
					type: "export",
					url,
					filename: value.filename,
					artifactId: value.artifactId,
				});
			}
		}
		this.emit({ type: "activities", activities: round.activities });
		if (
			effect.adapter === "subscriptionImage" &&
			round.activities.some((activity) => activity.ok)
		) {
			const receipt = this.editor.command
				.getEditingAgentSnapshot()
				?.receipts.at(-1);
			const artifactIds: string[] = [];
			const images: string[] = [];
			for (const id of receipt?.artifactIds ?? []) {
				const artifact =
					this.editor.command.readEditingConversationArtifact(id);
				if (artifact.mimeType !== "image/png") continue;
				const url = URL.createObjectURL(
					new Blob([Uint8Array.from(artifact.bytes)], {
						type: artifact.mimeType,
					}),
				);
				this.images.add(url);
				images.push(url);
				artifactIds.push(id);
			}
			if (images.length) this.emit({ type: "artifacts", images, artifactIds });
		}
		this.snapshot();
		await this.persist();
		return round;
	}
	private async respond({
		body,
		signal,
	}: {
		body: Record<string, unknown>;
		signal: AbortSignal;
	}) {
		await this.persist();
		signal.throwIfAborted();
		const expectedRevision = this.editor.command.getCanonicalRevision();
		return requestAgentResponse({
			beforeAttempt: () => {
				this.assertScope();
				if (this.editor.command.getCanonicalRevision() !== expectedRevision)
					throw new Error(
						"Editor revision changed before provider recovery; observe fresh state",
					);
			},
			planRetry: (failure) =>
				this.editor.command.planEditingProviderRetry(failure),
			onRetry: (attempt) =>
				this.emit({
					type: "status",
					text: `Provider temporarily unavailable. Retrying after attempt ${attempt}… No partial action was applied.`,
				}),
			send: () =>
				fetch("/api/editor-agent/respond", {
					method: "POST",
					credentials: "same-origin",
					headers: {
						"Content-Type": "application/json",
						"X-OpenCut-Account": this.account,
					},
					body: JSON.stringify(body),
					signal,
				}),
			signal,
			onEvent: (event) => {
				signal.throwIfAborted();
				this.assertScope();
				this.emit(event);
			},
		});
	}
	private async persist(): Promise<void> {
		this.assertScope();
		if (this.editor.command.hasAtomicSessionStorage())
			await this.editor.command.persistEditingSession();
		this.assertScope();
	}
	private async review({
		model,
		signal,
	}: {
		model: string;
		signal: AbortSignal;
	}) {
		const plan = this.editor.command.prepareEditingAgentReview();
		const frames: Array<{ artifactId: string; timeTicks: number }> = [],
			images: string[] = [];
		this.emit({ type: "round", review: true });
		this.emit({
			type: "summary",
			text: `Rendering ${plan.times.length} sample frames for visual review…`,
		});
		for (const ticks of plan.times) {
			signal.throwIfAborted();
			this.assertScope();
			if (this.editor.scenes.getActiveSceneOrNull()?.id !== plan.sceneId)
				throw new Error("The active scene changed during review");
			const frame = await this.editor.renderer.capturePreviewFrameAt({
				time: mediaTime({ ticks }),
				maxDimension: 1024,
				maxBytes: 180_000,
			});
			signal.throwIfAborted();
			this.assertScope();
			if (!frame.success)
				throw new Error(frame.error ?? "Could not render a review frame");
			const bytes = new Uint8Array(await frame.blob.arrayBuffer());
			signal.throwIfAborted();
			const artifact = this.editor.command.storeEditingAgentFrame(bytes);
			frames.push({ artifactId: artifact.id, timeTicks: ticks });
			const url = URL.createObjectURL(frame.blob);
			this.images.add(url);
			images.push(url);
		}
		const request = this.editor.command.prepareEditingAgentReviewRequest({
			model,
			epoch: plan.epoch,
			revision: plan.revision,
			frames,
		});
		const response = await this.respond({ body: request.body, signal });
		signal.throwIfAborted();
		this.assertScope();
		const result = this.editor.command.applyEditingAgentReview({
			epoch: request.epoch,
			response,
		});
		this.emit({
			type: "review",
			...result,
			images,
			artifactIds: frames.map((frame) => frame.artifactId),
		});
		this.snapshot();
		await this.persist();
	}
}
