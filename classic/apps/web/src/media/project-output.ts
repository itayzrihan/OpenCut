import type { DirectorReference } from "@/generative/types";

/** Ready jobs expose a project-owned file from the application's own API. */
export async function downloadProjectOutput({
	output,
	url,
	signal,
	lastModified,
}: {
	output: DirectorReference;
	url: string;
	signal: AbortSignal;
	lastModified: number;
}): Promise<File> {
	const response = await fetch(url, {
		credentials: "same-origin",
		cache: "no-store",
		signal,
	});
	if (!response.ok) throw new Error("Generated media download failed");
	const bytes = await response.blob();
	signal.throwIfAborted();
	if (!bytes.size || bytes.size !== output.bytes)
		throw new Error("Generated media download did not match the saved file");
	return new File([bytes], output.name, { type: output.mime, lastModified });
}
