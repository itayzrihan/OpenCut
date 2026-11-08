import { z } from "zod";
import type { EditorCore } from "@/core";
import type {
	EditingAgentHostEffect,
	EditingAgentHostResult,
} from "@/core/agent-protocol";
import { editorWriteHeaders } from "@/editor-agent/write-authority";
import type { PullJob } from "./types";

function publicJob(job: PullJob | null) {
	if (!job) return null;
	return {
		operationId: job.operationId,
		projectId: job.projectId,
		mediaId: job.mediaId,
		deviceId: job.deviceId,
		expectedBindingRevision: job.expectedBindingRevision,
		status: job.status,
		phase: job.phase,
		receivedBytes: job.receivedBytes,
		totalBytes: job.totalBytes,
		error: job.error ?? null,
	};
}
export async function performPeerMediaEffect({
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
	const scope = () => {
		signal.throwIfAborted();
		if (
			window.__opencutAccountId !== accountId ||
			editor.project.getActiveOrNull()?.metadata.id !== effect.projectId
		)
			throw new Error("Active transfer account or project changed");
	};
	scope();
	const request = z
		.object({
			operation: z.enum([
				"devices",
				"transfers",
				"start",
				"status",
				"cancel",
				"commit",
			]),
			input: z.record(z.string(), z.unknown()),
		})
		.strict()
		.parse(effect.request);
	if (request.input.projectId !== effect.projectId)
		return { type: "rejected", message: "Transfer project scope differs" };
	const operation =
		request.operation === "commit" ? "source" : request.operation;
	const response = await fetch("/api/peer-media", {
		method: "POST",
		credentials: "same-origin",
		cache: "no-store",
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
		headers: {
			"Content-Type": "application/json",
			"X-OpenCut-Account": accountId,
			...editorWriteHeaders({ accountId, projectId: effect.projectId }),
		},
		body: JSON.stringify({
			operation,
			projectId: effect.projectId,
			input: request.input,
		}),
	});
	const raw: unknown = await response.json();
	scope();
	if (!response.ok) {
		const rejection = z
			.object({ error: z.string(), definitive: z.literal(true) })
			.safeParse(raw);
		if (rejection.success)
			return { type: "rejected", message: rejection.data.error };
		throw new Error(
			"Transfer result is uncertain. Query the same operationId before retrying.",
		);
	}
	const data = z
		.object({
			job: z.record(z.string(), z.unknown()).nullable().optional(),
			jobs: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
			source: z.string().optional(),
			status: z
				.object({
					devices: z
						.array(
							z
								.object({
									id: z.string(),
									name: z.string(),
									lastSeenAt: z.number(),
								})
								.passthrough(),
						)
						.max(64),
					connected: z.boolean(),
					error: z.string().nullable(),
				})
				.passthrough()
				.optional(),
		})
		.passthrough()
		.parse(raw);
	let linked = false;
	if (request.operation === "commit") {
		const job = z
			.object({
				projectId: z.literal(effect.projectId),
				operationId: z.literal(String(request.input.operationId)),
				mediaId: z.string(),
				expectedBindingRevision: z.number().int().nonnegative(),
				status: z.literal("ready"),
			})
			.passthrough()
			.parse(data.job);
		if (!data.source) throw new Error("Verified original source is missing");
		await editor.media.relink({
			projectId: effect.projectId,
			id: job.mediaId,
			source: data.source,
			expectedRevision: job.expectedBindingRevision,
			requestId: job.operationId,
		});
		scope();
		const refreshed = editor.media
			.getAssets()
			.find((asset) => asset.id === job.mediaId);
		linked =
			!!refreshed &&
			!refreshed.missing &&
			refreshed.sourcePath === data.source &&
			(refreshed.bindingRevision ?? 0) > job.expectedBindingRevision;
		if (!linked)
			throw new Error(
				"Original was downloaded but its editor binding is still offline",
			);
	}
	if (request.operation === "devices" && !data.status?.connected)
		return {
			type: "rejected",
			message:
				data.status?.error ||
				"Enable device sharing and sign in through Legitate on both computers first",
		};
	return {
		type: "success",
		data: {
			projectId: effect.projectId,
			revision: editor.command.getCanonicalRevision(),
			linked,
			devices:
				data.status?.devices.map((device) => ({
					id: device.id,
					name: device.name,
					lastSeenAt: device.lastSeenAt,
				})) ?? [],
			job: publicJob((data.job ?? null) as PullJob | null),
			jobs: (data.jobs ?? []).map((job) => publicJob(job as PullJob)),
		},
	};
}
