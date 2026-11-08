import type { EditorCore } from "@/core";
import { performPeerMediaEffect } from "./editor-effect";
export type EditorPullJob = {
	operationId: string;
	projectId: string;
	mediaId: string;
	deviceId: string;
	expectedBindingRevision: number;
	status: string;
	phase: string;
	receivedBytes: number;
	totalBytes: number;
	error: string | null;
};
export type EditorPullReply = {
	projectId: string;
	revision: number;
	linked: boolean;
	devices: { id: string; name: string; lastSeenAt: number }[];
	job: EditorPullJob | null;
	jobs: EditorPullJob[];
};
type Invocation = {
	capabilityId: string;
	input: Record<string, unknown>;
	requestId: string;
};
// Transport reconciliation only, never a project state store. An uncertain
// external invocation must be replayed byte-for-byte before another host call.
const pending = new WeakMap<EditorCore, Map<string, Invocation>>();
type InvocationOptions = {
	editor: EditorCore;
	capabilityId: string;
	input?: Record<string, unknown>;
	signal: AbortSignal;
};
const queues = new WeakMap<EditorCore, Promise<void>>();
export async function invokePeerMedia(
	options: InvocationOptions,
): Promise<EditorPullReply> {
	const projectId = options.editor.project.getActiveOrNull()?.metadata.id,
		accountId = window.__opencutAccountId;
	const previous = queues.get(options.editor) ?? Promise.resolve();
	let release!: () => void;
	const done = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.catch(() => {}).then(() => done);
	queues.set(options.editor, tail);
	await previous.catch(() => {});
	try {
		options.signal.throwIfAborted();
		if (
			window.__opencutAccountId !== accountId ||
			options.editor.project.getActiveOrNull()?.metadata.id !== projectId
		)
			throw new Error("Queued transfer account or project changed");
		return await runPeerMedia(options);
	} finally {
		release();
		if (queues.get(options.editor) === tail) queues.delete(options.editor);
	}
}
async function runPeerMedia({
	editor,
	capabilityId,
	input = {},
	signal,
}: InvocationOptions): Promise<EditorPullReply> {
	const projectId = editor.project.getActiveOrNull()?.metadata.id,
		accountId = window.__opencutAccountId;
	if (!projectId || !accountId)
		throw new Error("Open your project before pulling its files");
	await editor.command.enableCanonical();
	let requests = pending.get(editor);
	if (!requests) {
		requests = new Map();
		pending.set(editor, requests);
	}
	const key = JSON.stringify([accountId, projectId]);
	const execute = async (invocation: Invocation) => {
		let called = false,
			settled = false;
		requests!.set(key, invocation);
		try {
			const result = await editor.command.invokeCanonicalMcp({
				capabilityId: invocation.capabilityId,
				input: invocation.input,
				context: {
					dryRun: false,
					requestId: invocation.requestId,
					metadata: { "opencut/projectId": projectId },
				},
				projectId,
				accountId,
				signal,
				host: async (effect) => {
					called = true;
					const reply = await performPeerMediaEffect({
						effect,
						editor,
						accountId,
						signal,
					});
					settled = true;
					return reply;
				},
			});
			requests!.delete(key);
			return result.output as EditorPullReply;
		} catch (error) {
			if (!called || settled) requests!.delete(key);
			throw error;
		}
	};
	const previous = requests.get(key);
	if (previous) {
		try {
			await execute(previous);
		} catch (error) {
			if (requests.has(key)) throw error;
		}
		if (
			["media.transfer.start", "media.transfer.commit"].includes(capabilityId)
		)
			throw new Error(
				"The previous transfer was reconciled. Refresh its progress before starting or linking another original.",
			);
	}
	return execute({
		capabilityId,
		input: {
			...input,
			projectId,
			expectedRevision: editor.command.getCanonicalRevision(),
		},
		requestId: crypto.randomUUID(),
	});
}
