/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Rust validates canonical registry projections; authenticated JSON is typed at this host transport boundary. */
import type { EditorCore } from "@/core";
import type { DirectorDocument, DirectorReference, DirectorStatus } from "./types";
export function scope(editor: EditorCore) {
	const projectId = editor.project.getActiveOrNull()?.metadata.id,
		accountId = window.__opencutAccountId;
	if (!projectId || !accountId)
		throw new Error("Open a project and sign in first");
	return { projectId, accountId };
}
export function canonical({
	editor,
	change,
}: {
	editor: EditorCore;
	change?: Record<string, unknown>;
}) {
	const { projectId, accountId } = scope(editor);
	return (
		change
			? editor.command.invokeCanonicalControl({
					projectId,
					accountId,
					capabilityId: change
						? "project.generative.edit"
						: "project.generative.read",
					input: change ? { change } : {},
				})
			: editor.command.readGenerative({ projectId, accountId })
	) as { document: DirectorDocument; instructions: string };
}
export function fileUrl({
	projectId,
	id,
	download = false,
}: {
	projectId: string;
	id: string;
	download?: unknown;
}) {
	const q = new URLSearchParams({
		projectId,
		file: id,
		account: window.__opencutAccountId ?? "",
	});
	if (download) q.set("download", "1");
	return "/api/generative?" + q;
}
export async function api<T = unknown>({
	projectId,
	action,
	data = {},
	signal,
}: {
	projectId: string;
	action?: string;
	data?: Record<string, unknown>;
	signal?: AbortSignal;
}): Promise<T> {
	const account = window.__opencutAccountId;
	if (!account) throw new Error("Sign in first");
	const response = await fetch(
		action
			? "/api/generative"
			: "/api/generative?" + new URLSearchParams({ projectId }),
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
	const result = await response.json().catch(() => {
		throw new Error(
			`POCUT returned an invalid Director response (HTTP ${response.status})`,
		);
	});
	if (window.__opencutAccountId !== account) throw new Error("Account changed");
	if (!response.ok) throw new Error(result.error || "Director request failed");
	return result as T;
}
export async function status({
	projectId,
	signal,
}: {
	projectId: string;
	signal?: AbortSignal;
}) {
	return api<DirectorStatus>({
		projectId: projectId,
		action: undefined,
		data: {},
		signal: signal,
	});
}
export async function uploadDirectorReference({
	projectId, accountId, file, name, signal,
}: {
	projectId: string;
	accountId: string;
	file: Blob;
	name: string;
	signal: AbortSignal;
}) {
	const form = new FormData();
	form.append("projectId", projectId);
	form.append("file", file, name);
	const response = await fetch("/api/generative", {
		method: "POST",
		headers: { "X-OpenCut-Account": accountId },
		body: form,
		signal,
	});
	const result: { reference?: DirectorReference; error?: string } = await response.json();
	if (!response.ok || !result.reference)
		throw new Error(result.error ?? "Could not store the reference image");
	return result.reference;
}
export function downloadFile({ url, name }: { url: string; name: string }) {
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	document.body.append(a);
	a.click();
	a.remove();
}
