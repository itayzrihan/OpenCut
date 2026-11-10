import type {
	EditingAgentHostEffect,
	EditingAgentHostResult,
} from "@/core/agent-protocol";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { useDirectorReviewFocus } from "./review-focus";
import { z } from "zod";
const envelope = z
	.object({
		projectId: z.string(),
		expectedRevision: z.number().int().nonnegative(),
		operationId: z.string(),
		operation: z
			.object({
				type: z.enum([
					"importReference",
					"prepare",
					"prepareChapters",
					"status",
				]),
			})
			.passthrough(),
	})
	.strict();
const replySchema = z
	.object({
		projectId: z.string(),
		revision: z.number(),
		reference: z.unknown().nullable(),
		job: z
			.object({
				id: z.string(),
				digest: z.string(),
				status: z.literal("review"),
				mediaId: z.null(),
			})
			.nullable(),
		jobs: z.array(z.unknown()).max(200),
		batch: z
			.object({
				id: z.string(),
				planId: z.string(),
				version: z.number().int(),
				jobIds: z.array(z.string()).max(32),
			})
			.optional(),
	})
	.strict();
/** No arbitrary endpoint/action forwarding. This adapter cannot submit paid work. */
export async function performGenerativeReviewEffect({
	effect,
	accountId,
	signal,
	activeProjectId,
	currentRevision,
}: {
	effect: EditingAgentHostEffect;
	accountId: string;
	signal: AbortSignal;
	activeProjectId?: () => string | undefined;
	currentRevision?: () => number | undefined;
}): Promise<EditingAgentHostResult> {
	const i = envelope.parse(effect.request);
	const check = () => {
		signal.throwIfAborted();
		if (
			effect.adapter !== "generativeReview" ||
			i.projectId !== effect.projectId ||
			activeProjectId?.() !== i.projectId ||
			currentRevision?.() !== i.expectedRevision ||
			window.__opencutAccountId !== accountId
		)
			throw new Error("Director MCP account, project or revision changed");
	};
	check();
	const response = await fetch("/api/generative/mcp", {
		method: "POST",
		credentials: "same-origin",
		cache: "no-store",
		signal,
		headers: {
			"Content-Type": "application/json",
			"X-OpenCut-Account": accountId,
		},
		body: JSON.stringify(i),
	});
	const raw: unknown = await response.json();
	if (!response.ok) {
		const error = z.object({ error: z.string() }).safeParse(raw);
		return {
			type: "rejected",
			message: error.success
				? error.data.error
				: "Director request unavailable",
		};
	}
	check();
	const out = replySchema.parse(raw);
	if (out.projectId !== i.projectId || out.revision !== i.expectedRevision)
		throw new Error("Director MCP reply scope changed");
	if (i.operation.type !== "status") {
		if (out.job)
			useDirectorReviewFocus.getState().reveal({
				accountId,
				projectId: i.projectId,
				jobId: out.job.id,
				surface: "agent",
			});
		if (out.batch)
			useDirectorReviewFocus.getState().reveal({
				accountId,
				projectId: i.projectId,
				jobId: out.batch.jobIds[0],
				batchId: out.batch.id,
				surface: "agent",
			});
		useAssetsPanelStore.getState().setActiveTab("generative");
	}
	return { type: "success", data: out };
}
