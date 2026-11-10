import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";

export const EXCHANGE_XML_EXTENSION = ".pocut.xml";
export const EXCHANGE_ACCEPT =
	".pocut.xml,.xml,.opencut.zip,.zip,application/xml,application/zip";
export const EXCHANGE_MANIFEST = "pocut-project.json";
export const MAX_METADATA_BYTES = 120_000_000;

export const exchangeAssetSchema = z
	.object({
		kind: z.enum([
			"media",
			"director",
			"font",
			"sharedAudio",
			"sharedSticker",
			"artifact",
		]),
		id: z
			.string()
			.min(1)
			.max(256)
			.regex(/^[a-zA-Z0-9_-]+$/),
		name: z.string().max(1000),
		fileName: z.string().min(1).max(1000),
		mimeType: z.string().max(200),
		size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		lastModified: z.number().nonnegative(),
		sha256: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		metadata: z.record(z.string(), z.unknown()),
	})
	.strict();
export type ExchangeAsset = z.infer<typeof exchangeAssetSchema>;
export const exchangeSchema = z
	.object({
		schema: z.literal("pocut.project.exchange"),
		version: z.literal(1),
		projectId: z.string().min(1).max(256),
		projectName: z.string().min(1).max(1000),
		exportedAt: z.string(),
		archive: z.unknown(),
		conversation: z.unknown().optional(),
		unavailableArtifactIds: z
			.array(z.string().min(1).max(256))
			.max(20_000)
			.optional(),
		omittedBinaryFields: z.array(z.string().max(200)).max(5000).optional(),
		assets: z.array(exchangeAssetSchema).max(20_000),
	})
	.strict()
	.superRefine((value, context) => {
		const keys = new Set<string>();
		for (const asset of value.assets) {
			const key = assetKey(asset);
			if (keys.has(key))
				context.addIssue({
					code: "custom",
					message: "Duplicate archive asset identity",
				});
			keys.add(key);
		}
	});
export type ProjectExchange = z.infer<typeof exchangeSchema>;
export const assetKey = (asset: Pick<ExchangeAsset, "kind" | "id">) =>
	`${asset.kind}:${asset.id}`;
export const assetPath = (asset: ExchangeAsset) =>
	`assets/${asset.kind}/${asset.id}`;

export function serializeProjectXml(value: ProjectExchange): string {
	const parsed = exchangeSchema.parse(value);
	const omitted = new Set<string>();
	const archive = structuredClone(parsed.archive) as Record<string, unknown>;
	const stripThumbnails = (value: unknown) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		const classic = value as {
			document?: { metadata?: Record<string, unknown> };
			mediaAssets?: Array<Record<string, unknown>>;
		};
		if (
			classic.document?.metadata &&
			"thumbnail" in classic.document.metadata
		) {
			delete classic.document.metadata.thumbnail;
			omitted.add("derivedProjectThumbnail");
		}
		for (const asset of classic.mediaAssets ?? [])
			if ("thumbnailUrl" in asset) {
				delete asset.thumbnailUrl;
				omitted.add("derivedMediaThumbnail");
			}
	};
	stripThumbnails(archive.classic);
	for (const stack of [archive.undoStack, archive.redoStack])
		if (Array.isArray(stack))
			for (const boundary of stack) stripThumbnails(boundary?.classic);
	// Historic public tool activities can contain old raw image-import arguments.
	// Preserve their transcript/receipts, but do not hide those media bytes in XML.
	const conversation =
		parsed.conversation === undefined
			? undefined
			: JSON.parse(
					JSON.stringify(parsed.conversation, (key, nested) => {
						if (
							[
								"dataBase64",
								"data_base64",
								"bytesBase64",
								"dataUrl",
								"thumbnailUrl",
							].includes(key) &&
							typeof nested === "string" &&
							nested.length
						) {
							omitted.add(key);
							return "[binary media omitted from metadata XML]";
						}
						return nested;
					}),
				);
	const json = JSON.stringify({
		...parsed,
		archive,
		conversation,
		...(omitted.size ? { omittedBinaryFields: [...omitted] } : {}),
	});
	if (new TextEncoder().encode(json).byteLength > MAX_METADATA_BYTES)
		throw new Error("Project metadata exceeds the XML size limit");
	const text = json
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<pocut-project version="1" format="lossless-metadata"><metadata encoding="json">${text}</metadata></pocut-project>\n`;
	if (new TextEncoder().encode(xml).byteLength > MAX_METADATA_BYTES)
		throw new Error("Project XML exceeds the size limit");
	return xml;
}

/** Deliberately accepts only our inert envelope, never a general XML language.
 * No DOM parser, DTD, entities, CDATA, namespace resolution or external IO. */
export function parseProjectXml(text: string): ProjectExchange {
	if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES)
		throw new Error("Project XML exceeds the size limit");
	if (/<!|<\?(?!xml\s)/i.test(text))
		throw new Error(
			"XML declarations, DTDs and external entities are not supported",
		);
	const match =
		/^\s*(?:<\?xml version="1\.0" encoding="UTF-8"\?>\s*)?<pocut-project version="1" format="lossless-metadata"><metadata encoding="json">([^<]*)<\/metadata><\/pocut-project>\s*$/.exec(
			text,
		);
	if (!match) throw new Error("This is not a POCUT lossless project XML file");
	if (/&(?!amp;|lt;|gt;)/.test(match[1]))
		throw new Error("Unsupported XML entity");
	const json = match[1].replace(
		/&(amp|lt|gt);/g,
		(_, entity: string) => ({ amp: "&", lt: "<", gt: ">" })[entity]!,
	);
	return exchangeSchema.parse(JSON.parse(json));
}

export async function hashExchangeFile(
	file: Blob,
	signal?: AbortSignal,
): Promise<string> {
	const digest = sha256.create();
	const reader = file.stream().getReader();
	try {
		while (true) {
			signal?.throwIfAborted();
			const { value, done } = await reader.read();
			if (done) break;
			digest.update(value);
		}
		signal?.throwIfAborted();
		return Array.from(digest.digest(), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
		digest.destroy();
	}
}

export async function verifyExchangeFile(
	asset: ExchangeAsset,
	file: File,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	if (file.size !== asset.size)
		throw new Error(
			`The selected file has a different size: ${asset.fileName}`,
		);
	if (asset.sha256 && (await hashExchangeFile(file, signal)) !== asset.sha256)
		throw new Error(
			`The selected file does not match the original SHA-256: ${asset.fileName}`,
		);
}

/** Filename/size matches are suggestions, not authority; duplicate candidates
 * remain unresolved and every selected file is verified before publication. */
export function suggestExchangeFiles(
	assets: ExchangeAsset[],
	files: File[],
): Map<string, File> {
	const matches = new Map<string, File>();
	for (const asset of assets) {
		const candidates = files.filter(
			(file) => file.name === asset.fileName && file.size === asset.size,
		);
		if (candidates.length === 1) matches.set(assetKey(asset), candidates[0]);
	}
	return matches;
}
