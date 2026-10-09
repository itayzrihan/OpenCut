import { open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { requireAccount } from "@/accounts/server";
import { listProjectMetadata } from "@/services/local-drive/server";

export class ReferenceRejected extends Error {}

/** IO only: the same Rust policy chooses the file and verifies its complete
 * digest/UTF-8 pagination. No model-supplied path is passed to the filesystem. */
export async function readBundledReference({
	request,
	directory,
}: {
	request: unknown;
	directory?: string;
}) {
	const { hyperframesReferenceSource } =
		await import("opencut-editor-runtime-wasm");
	let plan: { relativePath: string; bytes: number };
	try {
		plan = z
			.object({
				relativePath: z.string(),
				bytes: z.number().int().min(0).max(2_000_000),
			})
			.strict()
			.parse(hyperframesReferenceSource(request));
	} catch (error) {
		throw new ReferenceRejected(String(error));
	}
	const root = await realpath(
		directory ??
			resolve(
				process.cwd(),
				process.env.NODE_ENV === "production"
					? ".hyperframes-references"
					: "../../../resources/hyperframes",
			),
	);
	const path = await realpath(resolve(root, plan.relativePath));
	if (!path.startsWith(root + sep))
		throw new ReferenceRejected("Reference path escapes its bundle");
	const file = await open(path, "r");
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size !== plan.bytes)
			throw new ReferenceRejected(
				"Reference bundle size differs from its catalog",
			);
		// Fixed allocation also bounds a concurrently enlarged or corrupt file.
		const bytes = Buffer.alloc(plan.bytes + 1);
		let used = 0;
		while (used < bytes.length) {
			const result = await file.read(bytes, used, bytes.length - used, used);
			if (!result.bytesRead) break;
			used += result.bytesRead;
		}
		if (used !== plan.bytes)
			throw new ReferenceRejected("Reference bundle changed during read");
		try {
			return hyperframesReferenceSource(
				request,
				new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
					bytes.subarray(0, used),
				),
			);
		} catch (error) {
			throw new ReferenceRejected(String(error));
		}
	} finally {
		await file.close();
	}
}

export async function operateHyperframesReference({
	projectId,
	request,
}: {
	projectId: string;
	request: unknown;
}) {
	requireAccount();
	if (
		!(await listProjectMetadata()).some((project) => project.id === projectId)
	)
		throw new ReferenceRejected(
			"Open an owned project before reading references",
		);
	const scope = z
		.object({ projectId: z.literal(projectId) })
		.passthrough()
		.safeParse(request);
	if (!scope.success)
		throw new ReferenceRejected(
			"Reference request differs from the authenticated project scope",
		);
	return readBundledReference({ request });
}
