/** Host IO for canonical scene intents. No editor mutations, tool registry or
 * AI provider calls here: the existing background worker executes the recipe. */
import type { EditorCore } from "@/core";
import type {
	EditingAgentHostEffect,
	EditingAgentHostResult,
} from "@/core/agent-protocol";
import { storageService, deserializeProject } from "@/services/storage/service";
import type { SerializedProject } from "@/services/storage/types";
import { queueOwner } from "@/batch/scene-jobs";
import { z } from "zod";

const identity = z.string().min(1).max(160);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const intentSchema = z.object({
	id: identity,
	sceneId: identity,
	workerProjectId: identity,
	outputSceneId: identity,
	action: z.enum(["sound-effects", "word-animation", "full-auto"]),
	status: z.enum(["queued", "published"]),
	sourceFingerprint: fingerprint.optional(),
});
const sourceSchema = z.object({
	projectId: identity,
	jobId: identity,
	sceneId: identity,
	sourceFingerprint: fingerprint.optional(),
	mediaAssetIds: z.array(identity).optional(),
	fontIds: z.array(identity).optional(),
});
const requestSchema = z
	.object({
		operation: z.enum(["start", "status", "cancel"]),
		input: z
			.object({
				projectId: identity,
				expectedRevision: z.number().int().nonnegative(),
				jobId: identity,
				resume: z.boolean().default(false),
			})
			.strict(),
		job: intentSchema,
		worker: z.unknown().nullable(),
	})
	.strict();
const batchSchema = z.object({
	runs: z.array(
		z.object({
			id: identity,
			jobs: z.array(
				z.object({
					projectId: identity,
					sourceProjectId: identity.optional(),
					automationJobId: identity.optional(),
					status: z.enum([
						"queued",
						"importing",
						"ready",
						"running",
						"completed",
						"failed",
						"cancelled",
						"interrupted",
					]),
					completedStages: z.number().int().min(0).max(20),
					cancelRequested: z.boolean(),
					message: z.string(),
				}),
			),
		}),
	),
});

export async function performSceneAutomationEffect({
	effect,
	editor,
	accountId,
	signal,
}: {
	effect: EditingAgentHostEffect;
	editor: EditorCore;
	accountId: string;
	signal: AbortSignal;
}): Promise<EditingAgentHostResult> {
	const parsed = requestSchema.safeParse(effect.request);
	if (!parsed.success)
		return {
			type: "rejected",
			message: "Invalid scene automation host request",
		};
	const request = parsed.data;
	if (
		![
			request.input.projectId,
			request.input.jobId,
			request.job.workerProjectId,
		].every((id) => z.string().uuid().safeParse(id).success)
	)
		return {
			type: "rejected",
			message:
				"Scene execution requires UUID project, job and worker identities",
		};
	const { input, job } = request;
	const assertScope = () => {
		signal.throwIfAborted();
		if (
			effect.adapter !== "sceneAutomation" ||
			effect.projectId !== input.projectId ||
			job.id !== input.jobId ||
			(window.__opencutAccountId ?? "local") !== accountId ||
			editor.project.getActiveOrNull()?.metadata.id !== input.projectId ||
			editor.command.getCanonicalRevision() !== input.expectedRevision
		)
			throw new Error("Automation account, project, job or revision changed");
	};
	let externalWriteStarted = false;
	const queue = async (body?: Record<string, unknown>) => {
		assertScope();
		if (body) externalWriteStarted = true;
		const response = await fetch("/api/batch-edit", {
			method: body ? "POST" : "GET",
			credentials: "same-origin",
			cache: "no-store",
			signal,
			headers: {
				"Content-Type": "application/json",
				"X-OpenCut-Account": accountId,
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		const raw: unknown = await response.json();
		if (!response.ok) {
			const error = z.object({ error: z.string() }).safeParse(raw);
			throw new Error(
				error.success ? error.data.error : "Scene execution queue unavailable",
			);
		}
		assertScope();
		return batchSchema.parse(raw);
	};
	const resultFor = (state?: z.infer<typeof batchSchema>) => {
		const run = state?.runs.find((r) => r.id === job.id);
		const progress = run?.jobs.find(
			(j) =>
				j.automationJobId === job.id &&
				j.sourceProjectId === input.projectId &&
				j.projectId === job.workerProjectId,
		);
		if (run && !progress)
			throw new Error("Execution journal does not own this canonical job");
		return {
			type: "success" as const,
			data: {
				projectId: input.projectId,
				revision: input.expectedRevision,
				jobId: job.id,
				workerProjectId: job.workerProjectId,
				outputSceneId: job.outputSceneId,
				action: job.action,
				status:
					job.status === "published"
						? "published"
						: (progress?.status ?? "not-started"),
				completedStages: progress?.completedStages ?? 0,
				cancelRequested: progress?.cancelRequested ?? false,
				published: job.status === "published",
				message: (job.status === "published"
					? "Result published as a new scene"
					: (progress?.message ??
						"Queued intent has not started; call project.classic.automation.start")
				).slice(0, 1000),
			},
		};
	};
	try {
		assertScope();
		if (job.status === "published") return resultFor();
		let state = await queue();
		const existing = state.runs.find((r) => r.id === job.id);
		// Validates journal ownership before starting, resuming or cancelling it.
		resultFor(state);
		if (request.operation === "status") return resultFor(state);
		if (request.operation === "cancel") {
			if (existing)
				state = await queue({
					action: "cancel",
					id: job.id,
					projectId: job.workerProjectId,
				});
			return resultFor(state);
		}
		if (existing) {
			if (
				input.resume &&
				existing.jobs.every((j) => ["failed", "interrupted"].includes(j.status))
			)
				state = await queue({
					action: "retry",
					id: job.id,
					ownerId: queueOwner(),
					executor: "iframe",
				});
			return resultFor(state);
		}
		if (!job.sourceFingerprint)
			throw new Error(
				"Queue a new canonical intent with an immutable source fingerprint before launching it",
			);
		const saved = await storageService.loadProject({ id: job.workerProjectId });
		assertScope();
		const original = saved?.project ?? request.worker;
		if (!original)
			throw new Error(
				"Source changed before the worker was saved. Enqueue a fresh scene job; this intent was not started.",
			);
		const candidate = z
			.object({
				metadata: z.object({ id: identity }),
				automationSource: sourceSchema,
			})
			.parse(original);
		const origin = candidate.automationSource;
		if (
			candidate.metadata.id !== job.workerProjectId ||
			origin.sourceFingerprint !== job.sourceFingerprint ||
			origin.projectId !== input.projectId ||
			origin.jobId !== job.id ||
			origin.sceneId !== job.sceneId
		)
			throw new Error(
				"Saved or prepared worker differs from its immutable scene intent",
			);
		if (!origin.mediaAssetIds || !origin.fontIds)
			throw new Error(
				"Worker lacks its immutable media preparation manifest; enqueue a fresh job",
			);
		if (!saved) {
			// Rust constructs and validates this exact full project snapshot.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Only the registered Rust host supplies the serialized project.
			const worker = deserializeProject(original as SerializedProject);
			assertScope();
			externalWriteStarted = true;
			await storageService.saveProject({ project: worker });
		}
		const [savedAssets, savedFonts] = await Promise.all([
			storageService.loadAllMediaAssets({ projectId: job.workerProjectId }),
			storageService.loadAllProjectFonts({ projectId: job.workerProjectId }),
		]);
		const missingAssetIds = origin.mediaAssetIds.filter(
			(id) => !savedAssets.some((a) => a.id === id),
		);
		const missingFontIds = origin.fontIds.filter(
			(id) => !savedFonts.some((f) => f.id === id),
		);
		if (missingAssetIds.length || missingFontIds.length) {
			if (!request.worker)
				throw new Error(
					"Original media preparation is incomplete and the source changed. No replacement media was copied; enqueue a fresh job.",
				);
			const [assets, fonts] = await Promise.all([
				storageService.loadAllMediaAssets({ projectId: input.projectId }),
				storageService.loadAllProjectFonts({ projectId: input.projectId }),
			]);
			for (const id of missingAssetIds) {
				assertScope();
				const asset = assets.find((a) => a.id === id);
				if (!asset)
					throw new Error("An original source media binding is unavailable");
				externalWriteStarted = true;
				await storageService.saveMediaAsset({
					projectId: job.workerProjectId,
					mediaAsset: {
						...asset,
						file: undefined,
						storageKind: asset.sourcePath ? "linked" : asset.storageKind,
					},
				});
			}
			for (const id of missingFontIds) {
				assertScope();
				const font = fonts.find((f) => f.id === id);
				if (!font) throw new Error("An original source font is unavailable");
				externalWriteStarted = true;
				await storageService.saveProjectFont({
					projectId: job.workerProjectId,
					font,
				});
			}
		}
		// Flush the already-committed queue intent, never mutate a nested editor
		// document while a canonical host invocation is suspended.
		assertScope();
		await editor.save.flush();
		await editor.command.flushHistory();
		assertScope();
		state = await queue({
			action: "scenes",
			projectId: input.projectId,
			jobIds: [job.id],
			ownerId: queueOwner(),
			executor: "iframe",
		});
		return resultFor(state);
	} catch (error) {
		if (externalWriteStarted)
			throw new Error(
				`Scene startup may have saved or queued work. Reconcile this same jobId; do not enqueue a duplicate. ${error instanceof Error ? error.message : "Host response unavailable"}`,
			);
		return {
			type: "rejected",
			message:
				error instanceof Error ? error.message : "Scene automation unavailable",
		};
	}
}
