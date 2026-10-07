import type {
	EditingAgentHostEffect,
	EditingAgentHostResult,
} from "@/core/agent-protocol";
import { z } from "zod";
import { captureEditorUi } from "./editor-ui";
import { controlEditorUi } from "./ui-control";
import { editorWriteHeaders } from "./write-authority";

/** Adapter routing only, never a capability/tool table. Rust constructs the
 * bounded effect after live registry validation; the server owns authorization. */
const endpoints: Readonly<Record<string, string>> = {
	knowledge: "/api/editor-agent/knowledge",
	hyperframesReferences: "/api/editor-agent/hyperframes-references",
	hyperframesEmbedding: "/api/editor-agent/hyperframes-embedding",
	ownedProjects: "/api/editor-agent/owned-projects",
	ownedMediaTransfer: "/api/editor-agent/owned-projects",
};
export async function performHostEffect({
	effect,
	accountId,
	signal,
	activeProjectId,
	currentRevision,
	storeScreenshot,
	storeImage,
}: {
	effect: EditingAgentHostEffect;
	accountId: string;
	signal: AbortSignal;
	activeProjectId?: () => string | undefined;
	currentRevision?: () => number | undefined;
	storeScreenshot?: (capture: {
		bytes: Uint8Array;
		width: number;
		height: number;
	}) => unknown;
	storeImage?: (image: {
		bytes: Uint8Array;
		width: number;
		height: number;
	}) => unknown;
}): Promise<EditingAgentHostResult> {
	signal.throwIfAborted();
	if (effect.adapter === "subscriptionImage") {
		const scopeIsCurrent = () =>
			typeof window !== "undefined" &&
			(window.__opencutAccountId ?? "local") === accountId &&
			activeProjectId?.() === effect.projectId;
		if (!storeImage || !scopeIsCurrent())
			return {
				type: "rejected",
				message: "The scoped image artifact host is unavailable",
			};
		const response = await fetch("/api/editor-agent/subscription-image", {
			method: "POST",
			credentials: "same-origin",
			cache: "no-store",
			signal,
			headers: {
				"Content-Type": "application/json",
				"X-OpenCut-Account": accountId,
				...editorWriteHeaders({ accountId, projectId: effect.projectId }),
			},
			body: JSON.stringify({
				projectId: effect.projectId,
				request: effect.request,
			}),
		});
		const raw: unknown = await response.json();
		if (!response.ok) {
			const rejection = z
				.object({ error: z.string(), definitive: z.literal(true) })
				.safeParse(raw);
			if (rejection.success)
				return { type: "rejected", message: rejection.data.error };
			throw new Error(
				"Image operation result is uncertain. Reconcile the same operationId; do not generate again.",
			);
		}
		const image = z
			.object({
				projectId: z.literal(effect.projectId),
				jobKey: z.string().regex(/^[a-f0-9]{64}$/),
				mediaId: z.string(),
				fileName: z.string(),
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
				width: z.number().int().min(1).max(4096),
				height: z.number().int().min(1).max(4096),
				byteSize: z.number().int().min(24).max(16_000_000),
				lastModified: z.number().int().nonnegative(),
			})
			.strict()
			.parse(raw);
		const binary = await fetch(
			`/api/editor-agent/subscription-image?projectId=${encodeURIComponent(effect.projectId)}&jobKey=${image.jobKey}`,
			{
				credentials: "same-origin",
				cache: "no-store",
				signal,
				headers: { "X-OpenCut-Account": accountId },
			},
		);
		if (
			!binary.ok ||
			binary.headers.get("Content-Type") !== "image/png" ||
			!binary.body
		)
			throw new Error(
				"Saved image bytes unavailable; reconcile this operation",
			);
		const parts: Uint8Array[] = [];
		let size = 0;
		const reader = binary.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > image.byteSize) {
					await reader.cancel();
					throw new Error("Image download exceeds its declared bytes");
				}
				parts.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const part of parts) {
			bytes.set(part, offset);
			offset += part.length;
		}
		const hash = Array.from(
			new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
			(b) => b.toString(16).padStart(2, "0"),
		).join("");
		signal.throwIfAborted();
		if (!scopeIsCurrent() || size !== image.byteSize || hash !== image.sha256)
			throw new Error(
				"Image scope or checksum changed before artifact publication",
			);
		return {
			type: "success",
			data: {
				projectId: effect.projectId,
				operationId: z.object({ operationId: z.string() }).parse(effect.request)
					.operationId,
				mediaId: image.mediaId,
				fileName: image.fileName,
				lastModified: image.lastModified,
				artifact: storeImage({
					bytes,
					width: image.width,
					height: image.height,
				}),
			},
		};
	}
	if (effect.adapter === "editorScreenshot") {
		const request = z
			.object({
				projectId: z.string().min(1).max(256),
				expectedRevision: z.number().int().nonnegative(),
			})
			.strict()
			.parse(effect.request);
		const scopeIsCurrent = () =>
			typeof window !== "undefined" &&
			(window.__opencutAccountId ?? "local") === accountId &&
			activeProjectId?.() === effect.projectId &&
			request.projectId === effect.projectId;
		if (
			!scopeIsCurrent() ||
			!window.opencutElectron?.captureEditorScreenshot ||
			!storeScreenshot
		)
			return {
				type: "rejected",
				message: "The scoped desktop screenshot host is unavailable",
			};
		try {
			const capture = await window.opencutElectron.captureEditorScreenshot({
				accountId,
				projectId: effect.projectId,
			});
			signal.throwIfAborted();
			if (!scopeIsCurrent())
				throw new Error("The active account or project changed");
			const checked = z
				.object({
					bytes: z
						.instanceof(Uint8Array)
						.refine(
							(bytes) =>
								bytes.length > 3 &&
								bytes.length <= 2_000_000 &&
								bytes[0] === 255 &&
								bytes[1] === 216 &&
								bytes[2] === 255,
						),
					width: z.number().int().min(1).max(2048),
					height: z.number().int().min(1).max(2048),
				})
				.strict()
				.parse(capture);
			return {
				type: "success",
				data: {
					projectId: effect.projectId,
					revision: request.expectedRevision,
					artifact: storeScreenshot(checked),
				},
			};
		} catch {
			signal.throwIfAborted();
			return {
				type: "rejected",
				message: "The desktop screenshot failed or its scope changed",
			};
		}
	}
	if (effect.adapter === "editorUiControl") {
		if (typeof window === "undefined" || !activeProjectId || !currentRevision)
			return {
				type: "rejected",
				message: "The scoped UI control host is unavailable",
			};
		try {
			return {
				type: "success",
				data: await controlEditorUi({
					request: effect.request,
					accountId,
					projectId: activeProjectId,
					currentRevision,
					signal,
				}),
			};
		} catch (error) {
			signal.throwIfAborted();
			return {
				type: "rejected",
				message: error instanceof Error ? error.message : "UI control failed",
			};
		}
	}
	if (effect.adapter === "editorUi") {
		if (typeof window === "undefined" || !activeProjectId)
			return { type: "rejected", message: "The editor window is unavailable" };
		if (
			(window.__opencutAccountId ?? "local") !== accountId ||
			activeProjectId() !== effect.projectId
		)
			return {
				type: "rejected",
				message: "The active account or project changed",
			};
		try {
			return {
				type: "success",
				data: captureEditorUi({
					document: window.document,
					request: effect.request,
					projectId: effect.projectId,
				}),
			};
		} catch (error) {
			return {
				type: "rejected",
				message:
					error instanceof Error ? error.message : "UI observation failed",
			};
		}
	}
	const endpoint = endpoints[effect.adapter];
	if (!endpoint)
		throw new Error(
			"This host adapter is unavailable; the operation remains pending",
		);
	const ownedProjectOperation =
		effect.adapter === "ownedProjects" ||
		effect.adapter === "ownedMediaTransfer";
	const scopeIsCurrent = () =>
		typeof window !== "undefined" &&
		(window.__opencutAccountId ?? "local") === accountId &&
		activeProjectId?.() === effect.projectId;
	if (ownedProjectOperation && !scopeIsCurrent())
		return {
			type: "rejected",
			message: "The owned-project operation's active scope changed",
		};
	const response = await fetch(endpoint, {
		method: "POST",
		credentials: "same-origin",
		cache: "no-store",
		signal,
		headers: {
			"Content-Type": "application/json",
			"X-OpenCut-Account": accountId,
			...(effect.adapter === "ownedMediaTransfer"
				? editorWriteHeaders({ accountId, projectId: effect.projectId })
				: {}),
		},
		body: JSON.stringify({
			projectId: effect.projectId,
			request: effect.request,
			...(ownedProjectOperation
				? { copy: effect.adapter === "ownedMediaTransfer" }
				: {}),
		}),
	});
	const data: unknown = await response.json();
	signal.throwIfAborted();
	if (ownedProjectOperation && !scopeIsCurrent())
		throw new Error(
			"Owned-project scope changed after IO; reconcile the same operation before publishing",
		);
	if (!response.ok) {
		const rejection = z
			.object({ error: z.string(), definitive: z.literal(true) })
			.safeParse(data);
		if (rejection.success)
			return { type: "rejected", message: rejection.data.error };
		throw new Error(
			"The host operation's result is uncertain. Continue to reconcile the same request.",
		);
	}
	return { type: "success", data };
}
