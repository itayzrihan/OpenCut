import { z } from "zod";
import type { DirectorReference } from "./types";

/** Explicit archive bytes only; metadata never supplies a path or fetch URL. */
export async function uploadArchiveReference({
	projectId,
	accountId,
	id,
	sha256,
	file,
	name,
	storyboard = false,
	signal,
}: {
	projectId: string;
	accountId: string;
	id: string;
	sha256: string;
	file: Blob;
	name: string;
	storyboard?: boolean;
	signal?: AbortSignal;
}): Promise<DirectorReference> {
	if (window.__opencutAccountId !== accountId)
		throw new Error("Account changed");
	const form = new FormData();
	for (const [key, value] of Object.entries({
		projectId,
		id,
		sha256,
		name,
		storyboard: String(storyboard),
		archiveReference: "1",
	}))
		form.append(key, value);
	form.append("file", file, name);
	const response = await fetch("/api/generative", {
		method: "POST",
		credentials: "same-origin",
		headers: { "X-OpenCut-Account": accountId },
		body: form,
		signal,
	});
	const raw: unknown = await response.json();
	if (window.__opencutAccountId !== accountId)
		throw new Error("Account changed");
	if (!response.ok)
		throw new Error(z.object({ error: z.string() }).parse(raw).error);
	return z
		.object({
			reference: z.object({
				id: z.literal(id),
				name: z.literal(name),
				kind: z.enum(["image", "audio", "video"]),
				mime: z.literal(file.type),
				bytes: z.literal(file.size),
				storyboard: z.literal(storyboard),
			}),
		})
		.parse(raw).reference;
}
