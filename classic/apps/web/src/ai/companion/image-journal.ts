import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	writeFile,
	rename,
	readdir,
	stat,
} from "node:fs/promises";
import { join } from "node:path";
import { decodeGeneratedImage, type NativeProvider } from "./native-providers";
import type { ImageRequest } from "./protocol";

/** Provider IO journal only. Editor state and image import remain in the Rust runtime. */
export async function generateJournaledImage({
	root,
	provider,
	request,
	signal,
}: {
	root: string;
	provider: NativeProvider;
	request: ImageRequest;
	signal: AbortSignal;
}) {
	signal.throwIfAborted();
	const fingerprint = createHash("sha256")
		.update(JSON.stringify(request))
		.digest("hex");
	const key = createHash("sha256")
		.update(JSON.stringify([request.projectId, request.operationId]))
		.digest("hex");
	await mkdir(root, { recursive: true, mode: 0o700 });
	const journal = join(root, key + ".json"),
		file = join(root, key + ".image");
	const recover = async () => {
		const saved = z
			.object({
				fingerprint: z.string(),
				state: z.string(),
				sha256: z.string().optional(),
				completedAt: z.number().int().nonnegative().optional(),
			})
			.parse(JSON.parse(await readFile(journal, "utf8")));
		if (saved.fingerprint !== fingerprint)
			throw new Error("This image operation belongs to different content");
		if (saved.state !== "completed")
			throw new Error(
				"This image operation was already submitted. Its outcome is uncertain; do not start another request automatically.",
			);
		const info = await stat(file);
		if (info.size > 16_000_000)
			throw new Error("Saved image exceeds the limit");
		const bytes = await readFile(file);
		if (createHash("sha256").update(bytes).digest("hex") !== saved.sha256)
			throw new Error(
				"The saved image checksum differs; generation was not repeated",
			);
		return {
			...decodeGeneratedImage(bytes.toString("base64")),
			completedAt: z.number().int().nonnegative().parse(saved.completedAt),
		};
	};
	try {
		return await recover();
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
	}
	const files = await readdir(root);
	// Never evict uncertain dispatch records: removal could permit duplicate spend.
	if (files.filter((name) => name.endsWith(".json")).length >= 100)
		throw new Error(
			"This local profile reached its 100-image journal limit. Export your results before starting a new profile.",
		);
	const bytes = (
		await Promise.all(
			files
				.filter((name) => name.endsWith(".image"))
				.map((name) => stat(join(root, name))),
		)
	).reduce((total, item) => total + item.size, 0);
	if (bytes > 496_000_000)
		throw new Error("The local image cache reached its 512 MB limit");
	try {
		await writeFile(
			journal,
			JSON.stringify({
				fingerprint,
				state: "dispatched",
				startedAt: Date.now(),
			}),
			{ flag: "wx", mode: 0o600 },
		);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
			throw error;
		return recover();
	}
	signal.throwIfAborted();
	const output = await provider.image({ request: request, signal: signal });
	const checked = decodeGeneratedImage(output.base64);
	const image = Buffer.from(checked.base64, "base64");
	const temporary = join(root, key + "." + randomUUID() + ".tmp");
	await writeFile(temporary, image, { mode: 0o600 });
	await rename(temporary, file);
	const completedAt = Date.now();
	const complete = journal + "." + randomUUID() + ".tmp";
	await writeFile(
		complete,
		JSON.stringify({
			fingerprint,
			state: "completed",
			sha256: createHash("sha256").update(image).digest("hex"),
			completedAt,
		}),
		{ mode: 0o600 },
	);
	await rename(complete, journal);
	return { ...checked, completedAt };
}
