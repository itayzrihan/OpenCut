import { z } from "zod";
import type { EditorCore } from "@/core";
import { scope } from "@/generative/client";
import { audioDraftSchema, type AudioDraft } from "./types";
export function readAudioDrafts(editor: EditorCore) {
	const identity = scope(editor);
	return z
		.object({ drafts: z.array(audioDraftSchema) })
		.parse(editor.command.readAudioProduction(identity));
}
export function editAudioDraft({
	editor,
	draft,
	expectedDraftVersion,
}: {
	editor: EditorCore;
	draft: AudioDraft;
	expectedDraftVersion: number | null;
}) {
	editor.command.invokeCanonicalControl({
		...scope(editor),
		capabilityId: "project.audio.draft.edit",
		input: { draft, expectedDraftVersion },
	});
}
export async function audioApi<T>({
	projectId,
	action,
	data = {},
	signal,
	catalog = false,
}: {
	projectId: string;
	action?: string;
	data?: Record<string, unknown>;
	signal?: AbortSignal;
	catalog?: boolean;
}): Promise<T> {
	const account = window.__opencutAccountId;
	if (!account) throw new Error("Sign in first");
	const response = await fetch(
		action
			? "/api/audio-production"
			: "/api/audio-production?" +
					new URLSearchParams({
						projectId,
						...(catalog ? { catalog: "1" } : {}),
					}),
		{
			method: action ? "POST" : "GET",
			credentials: "same-origin",
			cache: "no-store",
			signal,
			headers: {
				"Content-Type": "application/json",
				"X-OpenCut-Account": account,
			},
			...(action
				? { body: JSON.stringify({ projectId, action, ...data }) }
				: {}),
		},
	);
	const raw: unknown = await response.json();
	if (window.__opencutAccountId !== account) throw new Error("Account changed");
	if (!response.ok)
		throw new Error(z.object({ error: z.string() }).parse(raw).error);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Authenticated same-origin response; canonical drafts are separately schema-validated.
	return raw as T;
}
export function audioFileUrl({
	projectId,
	id,
}: {
	projectId: string;
	id: string;
}) {
	return (
		"/api/audio-production?" +
		new URLSearchParams({
			projectId,
			file: id,
			account: window.__opencutAccountId ?? "",
		})
	);
}
