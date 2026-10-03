import { createHash, randomUUID } from "node:crypto";
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	rename,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { accountDataRoot } from "./server";
import { getProject } from "@/services/local-drive/server";
import { hashFile } from "./migration";

type Projection = (options: {
	projectJson: string;
	historyJson: string;
	sourceId: string;
	destinationId: string;
}) => string;
// Host-only copy adapter. The Rust projection owns document/history rebinding.
async function copyDirectory(source: string, destination: string) {
	await mkdir(destination, { recursive: true });
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if (entry.isSymbolicLink())
			throw new Error("Resolve symbolic links before browser recovery");
		const from = join(source, entry.name),
			to = join(destination, entry.name);
		if (entry.isDirectory()) await copyDirectory(from, to);
		else if (entry.isFile()) {
			await copyFile(from, to);
			if ((await hashFile(from)) !== (await hashFile(to)))
				throw new Error(
					`Browser recovery copy verification failed: ${entry.name}`,
				);
		}
	}
}
export async function prepareBrowserProjectRecovery(
	sourceId: string,
	destinationId: string,
	project: unknown,
	history: unknown,
	media: unknown,
	fonts: unknown,
	projection: Projection,
) {
	if (
		![sourceId, destinationId].every((id) =>
			/^[A-Za-z0-9_-]{1,160}$/.test(id),
		) ||
		sourceId === destinationId
	)
		throw new Error("Invalid recovery project IDs");
	const projectJson = JSON.stringify(project),
		historyJson = JSON.stringify(history ?? null);
	const mediaJson = JSON.stringify(media ?? []),
		fontsJson = JSON.stringify(fonts ?? []);
	const digest = createHash("sha256")
		.update(JSON.stringify([projectJson, historyJson, mediaJson, fontsJson]))
		.digest("hex");
	const projects = join(accountDataRoot(), "projects"),
		destination = join(projects, destinationId);
	const receiptName = "browser-recovery-source.json";
	const receipt = await readFile(join(destination, receiptName), "utf8")
		.then((raw) => JSON.parse(raw))
		.catch((error) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
	if (receipt) {
		if (receipt.sourceId !== sourceId || receipt.digest !== digest)
			throw new Error(
				"Browser source changed during recovery. Start a new explicit browser import; the previous copy was retained.",
			);
		return { projectId: destinationId };
	}
	if (!(await getProject(sourceId)))
		throw new Error("The original disk project is missing");
	if (await getProject(destinationId))
		throw new Error("Recovery never replaces an existing project");
	const projected = JSON.parse(
		projection({ projectJson, historyJson, sourceId, destinationId }),
	);
	const staging = join(
		accountDataRoot(),
		"browser-recovery-staging",
		randomUUID(),
	);
	await copyDirectory(join(projects, sourceId), staging);
	// Keep exact browser inputs independently of the editable recovered version.
	await mkdir(join(staging, "browser-originals"), { recursive: true });
	await writeFile(
		join(staging, "browser-originals", "project.json"),
		projectJson,
	);
	await writeFile(
		join(staging, "browser-originals", "history.json"),
		historyJson,
	);
	await writeFile(join(staging, "browser-originals", "media.json"), mediaJson);
	await writeFile(join(staging, "browser-originals", "fonts.json"), fontsJson);
	await writeFile(
		join(staging, "project.json"),
		JSON.stringify(projected.project),
	);
	await writeFile(
		join(staging, "history.json"),
		JSON.stringify(projected.history),
	);
	await writeFile(
		join(staging, receiptName),
		JSON.stringify({ sourceId, digest }),
	);
	await rename(staging, destination);
	return { projectId: destinationId };
}
