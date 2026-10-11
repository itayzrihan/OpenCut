import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { z } from "zod";
import {
	HyperframesPreviewHost,
	type HyperframesPreviewResource,
} from "./preview-host";
import { catalogPreviewDocument } from "./catalog-preview-document";
import type { HyperframesSource } from "./types";

const planSchema = z.object({
	missingFiles: z.array(z.string()).default([]),
	sourcePath: z.string(),
	entryFile: z.string(),
	files: z
		.array(
			z.object({
				path: z.string(),
				bytes: z
					.number()
					.int()
					.min(0)
					.max(32 * 1024 * 1024),
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
			}),
		)
		.max(512),
	width: z.number().int().min(1).max(8192),
	height: z.number().int().min(1).max(8192),
	durationSeconds: z.number().positive(),
});
const mime: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".glb": "model/gltf-binary",
};
async function within({ root, relative }: { root: string; relative: string }) {
	if (
		!relative ||
		/[\\:]/.test(relative) ||
		relative.split("/").some((p) => !p || p === "." || p === "..")
	)
		throw new Error("Invalid reference path");
	const path = await realpath(resolve(root, relative));
	if (!path.startsWith(root + sep))
		throw new Error("Reference escaped its package");
	return path;
}

/** IO adapter only. The canonical registry selects every package/file. */
export async function loadCatalogPreviewPackage({
	input,
	directory,
}: {
	input: unknown;
	directory?: string;
}) {
	const plan = planSchema.parse(input);
	if (plan.files.reduce((sum, f) => sum + f.bytes, 0) > 64 * 1024 * 1024)
		throw new Error("Preview package is too large");
	const root = await realpath(
		directory ??
			resolve(
				process.cwd(),
				process.env.NODE_ENV === "production"
					? ".hyperframes-references"
					: "../../../resources/hyperframes",
			),
	);
	const sourceRoot = await within({ root, relative: plan.sourcePath });
	const source: HyperframesSource = {
		entryFile: plan.entryFile,
		files: {},
		resourceAssetIds: {},
	};
	const resources = new Map<string, HyperframesPreviewResource>();
	for (const file of plan.files) {
		const path = await within({ root: sourceRoot, relative: file.path });
		const handle = await open(path, "r");
		let bytes: Buffer;
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size !== file.bytes)
				throw new Error(`Reference integrity failed: ${file.path}`);
			bytes = Buffer.alloc(file.bytes + 1);
			let used = 0;
			while (used < bytes.length) {
				const result = await handle.read(
					bytes,
					used,
					bytes.length - used,
					used,
				);
				if (!result.bytesRead) break;
				used += result.bytesRead;
			}
			bytes = bytes.subarray(0, used);
		} finally {
			await handle.close();
		}
		if (
			bytes.length !== file.bytes ||
			createHash("sha256").update(bytes).digest("hex") !== file.sha256
		)
			throw new Error(`Reference integrity failed: ${file.path}`);
		if (/\.(html|css|js|mjs|json|svg|md|txt)$/i.test(file.path))
			source.files[file.path] = new TextDecoder("utf-8", {
				fatal: true,
			}).decode(bytes);
		else {
			source.resourceAssetIds[file.path] = file.sha256;
			resources.set(file.path, {
				path,
				size: bytes.length,
				mimeType: mime[extname(file.path)] ?? "application/octet-stream",
			});
		}
	}
	if (!Object.hasOwn(source.files, plan.entryFile))
		throw new Error("Preview entry is missing");
	return {
		plan,
		source,
		resources,
		html: catalogPreviewDocument({
			html: source.files[plan.entryFile],
			durationSeconds: plan.durationSeconds,
		}),
	};
}

export class CatalogPreviews {
	private host = new HyperframesPreviewHost();
	private leases = new Map<string, { accountId: string; created: number }>();
	private pending = 0;
	async open({
		accountId,
		input,
		signal,
	}: {
		accountId: string;
		input: { id: string; upstreamCommit: string };
		signal: AbortSignal;
	}) {
		if (this.pending >= 2)
			throw new Error("A catalog preview is loading; try again shortly");
		this.pending++;
		try {
			const { CanonicalEditorRuntime } =
				await import("opencut-editor-runtime-wasm");
			const runtime = new CanonicalEditorRuntime();
			let plan: unknown;
			try {
				plan = runtime.invokeSync(
					"hyperframes.examples.preview.plan",
					input,
					null,
				).result.data;
			} finally {
				runtime.free();
			}
			const prepared = await loadCatalogPreviewPackage({ input: plan });
			signal.throwIfAborted();
			// Derived public catalog leases are bounded independently from project previews.
			for (const [id, lease] of this.leases)
				if (Date.now() - lease.created > 5 * 60_000 || this.leases.size >= 6)
					this.release({ accountId: lease.accountId, id });
			const lease = await this.host.add(prepared);
			this.leases.set(lease.id, { accountId, created: Date.now() });
			return {
				...lease,
				width: prepared.plan.width,
				height: prepared.plan.height,
				missingFiles: prepared.plan.missingFiles,
			};
		} finally {
			this.pending--;
		}
	}
	release({ accountId, id }: { accountId: string; id: string }) {
		if (this.leases.get(id)?.accountId === accountId) {
			this.host.remove({ id });
			this.leases.delete(id);
		}
	}
	async close() {
		this.leases.clear();
		await this.host.close();
	}
}
const state = globalThis as typeof globalThis & {
	__opencutCatalogPreviews?: CatalogPreviews;
};
export const catalogPreviews = () =>
	(state.__opencutCatalogPreviews ??= new CatalogPreviews());
