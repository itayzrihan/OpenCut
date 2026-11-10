/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Canonical exchange projections are validated by the Rust registry before these transport adapters use them. */
import { loadCanonicalRuntime } from "@/core/load-canonical-runtime";
import type { CanonicalHistoryArchive } from "@/core/canonical-classic-session";
import type { MediaAsset } from "@/media/types";
import type { ProjectFontAsset } from "@/fonts/types";
import { storageService } from "@/services/storage/service";
import {
	localDriveRequest,
	captureLocalDriveWriteScope,
	assertLocalDriveWriteScope,
} from "@/services/local-drive/client";
import { hostedMedia } from "@/services/storage/hosted-media";
import { isHostedBrowserWorkspace } from "@/accounts/browser";
import { fileUrl } from "@/generative/client";
import { uploadArchiveReference } from "@/generative/archive-reference-client";
import { generateUUID } from "@/utils/id";
import {
	EditorSessionClient,
	EditorSessionFailure,
	type EditorSessionBundle,
} from "@/editor-agent/session-client";
import type {
	EditingArtifactArchive,
	EditingConversationArchive,
} from "@/core/agent-protocol";
import {
	collectSharedExchangeAssets,
	importSharedExchangeAsset,
} from "./shared-assets";
import { createZipBlob, readZipEntries } from "./zip";
import {
	type ProjectExchange,
	type ExchangeAsset,
	exchangeSchema,
	assetKey,
	assetPath,
	EXCHANGE_MANIFEST,
	MAX_METADATA_BYTES,
	hashExchangeFile,
	parseProjectXml,
	serializeProjectXml,
	verifyExchangeFile,
} from "./exchange-format";

type Prepared = {
	archive: CanonicalHistoryArchive;
	classic: { document: Record<string, unknown>; mediaAssets: MediaAsset[] };
	projectExtensions: Record<string, unknown>;
	mediaAssets: MediaAsset[];
	references: Array<{
		id: string;
		name: string;
		mime: string;
		bytes: number;
		storyboard: boolean;
	}>;
};
export type ExchangeImportPlan = {
	payload: ProjectExchange;
	files: Map<string, File>;
	source: "xml" | "zip";
};

async function prepare(
	archive: CanonicalHistoryArchive,
	destinationProjectId?: string,
	maps?: {
		sharedAudioIds: Record<string, string>;
		sharedStickerIds: Record<string, string>;
	},
) {
	const runtime = await loadCanonicalRuntime();
	try {
		return runtime.invokeSync(
			"project.classic.exchange.prepare",
			{
				projectId: archive.projectId,
				expectedRevision: archive.revision,
				archive,
				destinationProjectId,
				...maps,
			},
			{},
		).result.data as Prepared;
	} finally {
		runtime.free();
	}
}
function metadata(value: unknown): Record<string, unknown> {
	const object = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
	for (const field of [
		"file",
		"url",
		"thumbnailUrl",
		"sourcePath",
		"storedPath",
		"sourceUrl",
		"repositoryPath",
		"dataUrl",
	])
		delete object[field];
	return object;
}
function knownHash(value: unknown): string | undefined {
	const asset = value as { sha256?: string; generation?: { sha256?: string } };
	const hash = asset.sha256 ?? asset.generation?.sha256;
	return hash && /^[a-f0-9]{64}$/.test(hash) ? hash : undefined;
}
async function fetchedFile(
	url: string,
	name: string,
	mimeType: string,
	lastModified: number,
	signal?: AbortSignal,
): Promise<File> {
	const response = await fetch(url, {
		credentials: "same-origin",
		signal,
		cache: "no-store",
	});
	if (!response.ok) throw new Error(`Original file is unavailable: ${name}`);
	return new File([await response.blob()], name, {
		type: mimeType,
		lastModified,
	});
}

export async function createProjectExchange({
	bundle,
	mediaAssets,
	projectFonts,
	format,
	signal,
	onProgress,
}: {
	bundle: EditorSessionBundle;
	mediaAssets: MediaAsset[];
	projectFonts: ProjectFontAsset[];
	format: "zip" | "xml";
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}): Promise<Blob> {
	const archive = bundle.archive;
	const accountId = window.__opencutAccountId;
	const check = () => {
		signal?.throwIfAborted();
		if (window.__opencutAccountId !== accountId)
			throw new Error("The account changed during project export");
	};
	const prepared = await prepare(archive);
	check();
	const live = new Map(mediaAssets.map((asset) => [asset.id, asset]));
	const assets: ExchangeAsset[] = [];
	const readers = new Map<string, () => Promise<File | null>>();
	const add = (asset: ExchangeAsset, read: () => Promise<File | null>) => {
		assets.push(asset);
		readers.set(assetKey(asset), read);
	};
	for (const original of prepared.mediaAssets) {
		if (original.unifiedAngles) continue;
		const asset = live.get(original.id) ?? original;
		const descriptor: ExchangeAsset = {
			kind: "media",
			id: asset.id,
			name: asset.name,
			fileName: asset.file?.name || asset.fileName || asset.name,
			mimeType:
				asset.file?.type || asset.mimeType || "application/octet-stream",
			size: asset.file?.size ?? asset.size ?? 0,
			lastModified: asset.file?.lastModified ?? asset.lastModified ?? 0,
			sha256: knownHash(original),
			metadata: metadata(original),
		};
		add(descriptor, async () => {
			const current =
				live.get(asset.id) ??
				(await storageService.loadMediaAsset({
					projectId: archive.projectId,
					id: asset.id,
				}));
			check();
			if (current?.file) return current.file;
			if (current?.url)
				return fetchedFile(
					current.url,
					descriptor.fileName,
					descriptor.mimeType,
					descriptor.lastModified,
					signal,
				);
			return null;
		});
	}
	for (const ref of prepared.references)
		add(
			{
				kind: "director",
				id: ref.id,
				name: ref.name,
				fileName: ref.name,
				mimeType: ref.mime,
				size: ref.bytes,
				lastModified: 0,
				metadata: metadata(ref),
			},
			() =>
				fetchedFile(
					fileUrl({ projectId: archive.projectId, id: ref.id }),
					ref.name,
					ref.mime,
					0,
					signal,
				),
		);
	const full = prepared.archive as unknown as {
		classic: { document: Record<string, unknown> };
		undoStack: Array<{ classic: { document: Record<string, unknown> } }>;
		redoStack: Array<{ classic: { document: Record<string, unknown> } }>;
	};
	const documents = [
		full.classic.document,
		...full.undoStack.map((b) => b.classic.document),
		...full.redoStack.map((b) => b.classic.document),
	];
	const fonts = new Map<string, Record<string, unknown>>();
	for (const document of documents)
		for (const value of Array.isArray(document.customFonts)
			? document.customFonts
			: []) {
			const font = value as Record<string, unknown>;
			if (typeof font.id === "string") fonts.set(font.id, font);
		}
	for (const [id, record] of fonts) {
		const font = projectFonts.find((item) => item.id === id);
		add(
			{
				kind: "font",
				id,
				name: font?.family ?? String(record.family ?? record.name ?? id),
				fileName: font?.fileName ?? String(record.fileName ?? id),
				mimeType: font?.mimeType ?? String(record.mimeType ?? "font/ttf"),
				size: font?.file.size ?? Number(record.size ?? 0),
				lastModified: font?.lastModified ?? Number(record.lastModified ?? 0),
				metadata: metadata(font ?? record),
			},
			async () => font?.file ?? null,
		);
	}
	for (const item of bundle.artifacts?.archive.items ?? []) {
		const meta = item.metadata;
		const filename =
			bundle.conversation?.entries.find(
				(entry) => entry.export?.artifactId === meta.id,
			)?.export?.filename ??
			bundle.conversation?.entries
				.flatMap((entry) => entry.attachments ?? [])
				.find((attachment) => attachment.artifactId === meta.id)?.filename ??
			`${meta.id}.bin`;
		add(
			{
				kind: "artifact",
				id: meta.id,
				name: filename,
				fileName: filename,
				mimeType: meta.mimeType,
				size: meta.byteSize,
				lastModified: 0,
				sha256: meta.sha256,
				metadata: metadata(meta),
			},
			async () =>
				new File(
					[
						Uint8Array.from(atob(item.dataBase64), (char) =>
							char.charCodeAt(0),
						),
					],
					filename,
					{ type: meta.mimeType },
				),
		);
	}
	const shared = await collectSharedExchangeAssets(documents);
	check();
	for (const asset of shared) {
		const { getFile, ...descriptor } = asset;
		add(descriptor, getFile);
	}
	const entries: Array<{ path: string; data: Blob | string }> = [];
	if (format === "zip")
		for (const asset of assets) {
			check();
			onProgress?.(asset.fileName);
			const file = await readers.get(assetKey(asset))!();
			check();
			if (!file)
				throw new Error(
					`Original file is missing: ${asset.fileName}. Relink it or export metadata XML.`,
				);
			if (file.size !== asset.size)
				throw new Error(
					`Original file changed during export: ${asset.fileName}`,
				);
			const hash = await hashExchangeFile(file, signal);
			check();
			if (asset.sha256 && asset.sha256 !== hash)
				throw new Error(`Original file checksum changed: ${asset.fileName}`);
			asset.sha256 = hash;
			entries.push({ path: assetPath(asset), data: file });
		}
	const document = prepared.classic.document as { metadata: { name: string } };
	const payload = exchangeSchema.parse({
		schema: "pocut.project.exchange",
		version: 1,
		projectId: archive.projectId,
		projectName: document.metadata.name,
		exportedAt: new Date().toISOString(),
		archive: prepared.archive,
		assets,
		conversation: bundle.conversation,
		unavailableArtifactIds: bundle.artifacts?.unavailableIds,
	});
	check();
	if (format === "xml")
		return new Blob([serializeProjectXml(payload)], {
			type: "application/xml;charset=utf-8",
		});
	const json = JSON.stringify(payload);
	if (new TextEncoder().encode(json).byteLength > MAX_METADATA_BYTES)
		throw new Error("Project metadata exceeds the size limit");
	return createZipBlob({
		entries: [{ path: EXCHANGE_MANIFEST, data: json }, ...entries],
	});
}

export async function validateExchangeBundle({
	plan,
	prepared,
	files,
	accountId,
	signal,
}: {
	plan: ExchangeImportPlan;
	prepared: Prepared;
	files: Map<string, File>;
	accountId: string;
	signal?: AbortSignal;
}): Promise<EditorSessionBundle> {
	const projectId = prepared.archive.projectId;
	const artifactAssets = plan.payload.assets.filter(
		(asset) => asset.kind === "artifact",
	);
	// Account for encoded bytes before reading even the first binary. The later
	// Rust ArtifactStore and final session check remain authoritative as well.
	const envelope = {
		archive: prepared.archive,
		agentCheckpoint: null,
		conversation: plan.payload.conversation,
		artifacts: {
			accountId,
			projectId,
			unavailableIds: plan.payload.unavailableArtifactIds ?? [],
			archive: {
				schemaVersion: 1,
				items: artifactAssets.map((asset) => ({
					metadata: asset.metadata,
					dataBase64: "",
				})),
			},
		},
	};
	let remaining =
		120_000_000 - new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
	if (remaining < 0)
		throw new Error(
			"The project and saved artifacts exceed the session storage limit",
		);
	for (const asset of artifactAssets) {
		const file = files.get(assetKey(asset));
		if (!file)
			throw new Error(`Select the original artifact: ${asset.fileName}`);
		if (file.size !== asset.size)
			throw new Error("Artifact file size differs from its descriptor");
		if (asset.size > 64 * 1024 * 1024)
			throw new Error("Artifact exceeds the canonical 64 MiB limit");
		const encoded = 4 * Math.ceil(asset.size / 3);
		if (encoded > remaining)
			throw new Error(
				"The project and saved artifacts exceed the session storage limit",
			);
		remaining -= encoded;
	}
	const runtime = await loadCanonicalRuntime();
	try {
		runtime.invokeSync(
			"project.classic.session.restore",
			{ projectId, expectedRevision: 0, archive: prepared.archive },
			{},
		);
		const artifacts: EditingArtifactArchive = {
			accountId,
			projectId,
			archive: { schemaVersion: 1, items: [] },
			unavailableIds: plan.payload.unavailableArtifactIds ?? [],
		};
		for (const asset of artifactAssets) {
			signal?.throwIfAborted();
			const file = files.get(assetKey(asset));
			if (!file)
				throw new Error(`Select the original artifact: ${asset.fileName}`);
			if (file.size > 64 * 1024 * 1024)
				throw new Error("Artifact exceeds the canonical 64 MiB limit");
			const bytes = new Uint8Array(await file.arrayBuffer());
			let binary = "";
			for (let i = 0; i < bytes.length; i += 32_768)
				binary += String.fromCharCode(...bytes.subarray(i, i + 32_768));
			artifacts.archive.items.push({
				metadata:
					asset.metadata as EditingArtifactArchive["archive"]["items"][number]["metadata"],
				dataBase64: btoa(binary),
			});
		}
		runtime.restoreConversationArtifacts(accountId, projectId, artifacts);
		let conversation: EditingConversationArchive | undefined;
		if (plan.payload.conversation) {
			runtime.conversationRestore(accountId, projectId, {
				...(plan.payload.conversation as EditingConversationArchive),
				accountId,
				projectId,
			});
			conversation = runtime.conversationRead(
				accountId,
				projectId,
			) as EditingConversationArchive;
		}
		signal?.throwIfAborted();
		return {
			archive: prepared.archive,
			agentCheckpoint: null,
			conversation,
			artifacts,
		};
	} finally {
		runtime.free();
	}
}

/** Parsing/validation has no writes. A legacy ZIP returns null to use its
 * established backwards-compatible importer. */
export async function readProjectExchange(
	file: File,
	signal?: AbortSignal,
): Promise<ExchangeImportPlan | null> {
	signal?.throwIfAborted();
	let payload: ProjectExchange;
	const files = new Map<string, File>();
	const xml = /\.xml$/i.test(file.name) || file.type.includes("xml");
	if (xml) {
		if (file.size > MAX_METADATA_BYTES)
			throw new Error("Project XML exceeds the size limit");
		payload = parseProjectXml(await file.text());
	} else {
		const entries = await readZipEntries({ blob: file });
		signal?.throwIfAborted();
		const manifest = entries.get(EXCHANGE_MANIFEST);
		if (!manifest) return null;
		if (manifest.uncompressedSize > MAX_METADATA_BYTES)
			throw new Error("Project metadata exceeds the size limit");
		payload = exchangeSchema.parse(await manifest.json());
		for (const asset of payload.assets) {
			const entry = entries.get(assetPath(asset));
			if (entry)
				files.set(
					assetKey(asset),
					new File([entry.blob], asset.fileName, {
						type: asset.mimeType,
						lastModified: asset.lastModified,
					}),
				);
		}
	}
	const canonical = await prepare(payload.archive as CanonicalHistoryArchive);
	signal?.throwIfAborted();
	if (canonical.archive.projectId !== payload.projectId)
		throw new Error("Project archive identity mismatch");
	const required = [
		...canonical.mediaAssets
			.filter((asset) => !asset.unifiedAngles)
			.map((asset) => `media:${asset.id}`),
		...canonical.references.map((ref) => `director:${ref.id}`),
	];
	const keys = new Set(payload.assets.map(assetKey));
	if (required.some((key) => !keys.has(key)))
		throw new Error("Project archive is missing required asset descriptors");
	const full = canonical.archive as unknown as {
		classic: { document: Record<string, unknown> };
		undoStack: Array<{ classic: { document: Record<string, unknown> } }>;
		redoStack: Array<{ classic: { document: Record<string, unknown> } }>;
	};
	const documents = [
		full.classic.document,
		...full.undoStack.map((b) => b.classic.document),
		...full.redoStack.map((b) => b.classic.document),
	];
	const fontIds = new Set<string>();
	const canonicalFonts = new Map<string, Record<string, unknown>>();
	const sharedAudioIds = new Set<string>();
	const sharedStickerIds = new Set<string>();
	const scan = (value: unknown): void => {
		if (Array.isArray(value)) {
			value.forEach(scan);
			return;
		}
		if (!value || typeof value !== "object") return;
		const obj = value as Record<string, unknown>;
		if (
			obj.type === "audio" &&
			obj.sourceType === "library" &&
			obj.librarySourceType === "shared" &&
			typeof obj.libraryAssetId === "string"
		)
			sharedAudioIds.add(obj.libraryAssetId);
		if (
			obj.type === "sticker" &&
			typeof obj.stickerId === "string" &&
			obj.stickerId.startsWith("user-stickers:")
		)
			sharedStickerIds.add(obj.stickerId.slice(14));
		Object.values(obj).forEach(scan);
	};
	for (const doc of documents) {
		for (const font of Array.isArray(doc.customFonts) ? doc.customFonts : []) {
			if (typeof (font as { id?: unknown }).id === "string") {
				fontIds.add((font as { id: string }).id);
				canonicalFonts.set(
					(font as { id: string }).id,
					font as Record<string, unknown>,
				);
			}
		}
		scan(doc);
	}
	for (const [kind, ids] of [
		["font", fontIds],
		["sharedAudio", sharedAudioIds],
		["sharedSticker", sharedStickerIds],
	] as const)
		for (const id of ids)
			if (!keys.has(`${kind}:${id}`))
				throw new Error(
					`Project archive is missing a required ${kind} descriptor`,
				);
	for (const asset of payload.assets) {
		if (asset.metadata.id !== asset.id)
			throw new Error("Archive asset identity differs from its descriptor");
		if (asset.kind === "director") {
			const ref = canonical.references.find((ref) => ref.id === asset.id);
			if (!ref || ref.bytes !== asset.size || ref.mime !== asset.mimeType)
				throw new Error(
					"Archive reference metadata differs from the canonical project",
				);
		}
		if (asset.kind === "media") {
			const media = canonical.mediaAssets.find(
				(media) => media.id === asset.id,
			);
			if (
				!media ||
				media.unifiedAngles ||
				(media.mimeType && media.mimeType !== asset.mimeType) ||
				(knownHash(media) && knownHash(media) !== asset.sha256) ||
				(media.size !== undefined &&
					media.size > 0 &&
					media.size !== asset.size)
			)
				throw new Error(
					"Archive media metadata differs from the canonical project",
				);
		}
		if (asset.kind === "font") {
			const font = canonicalFonts.get(asset.id);
			if (
				!font ||
				(font.size !== undefined && font.size !== asset.size) ||
				(font.mimeType !== undefined && font.mimeType !== asset.mimeType) ||
				(font.family !== undefined && font.family !== asset.name) ||
				(asset.metadata.size !== undefined &&
					asset.metadata.size !== asset.size) ||
				(asset.metadata.mimeType !== undefined &&
					asset.metadata.mimeType !== asset.mimeType)
			)
				throw new Error(
					"Archive font metadata differs from the canonical project",
				);
		}
		if (asset.kind === "sharedAudio" || asset.kind === "sharedSticker") {
			const ids =
				asset.kind === "sharedAudio" ? sharedAudioIds : sharedStickerIds;
			if (
				!ids.has(asset.id) ||
				asset.metadata.size !== asset.size ||
				asset.metadata.mimeType !== asset.mimeType
			)
				throw new Error(
					"Shared asset metadata differs from the canonical project",
				);
		}
		if (
			asset.kind === "artifact" &&
			(asset.metadata.byteSize !== asset.size ||
				asset.metadata.sha256 !== asset.sha256 ||
				asset.metadata.mimeType !== asset.mimeType)
		)
			throw new Error("Artifact metadata differs from its descriptor");
	}
	return {
		payload: { ...payload, archive: canonical.archive },
		files,
		source: xml ? "xml" : "zip",
	};
}

export async function importProjectExchange({
	plan,
	selections,
	signal,
	onProgress,
}: {
	plan: ExchangeImportPlan;
	selections: Map<string, File>;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}): Promise<{ projectId: string; projectName: string }> {
	const projectId = generateUUID();
	const scope = { ...captureLocalDriveWriteScope({ projectId }), signal };
	const check = () => {
		signal?.throwIfAborted();
		assertLocalDriveWriteScope({ projectId, scope });
	};
	for (const asset of plan.payload.assets) {
		check();
		const file = selections.get(assetKey(asset));
		if (!file) throw new Error(`Select the original file: ${asset.fileName}`);
		onProgress?.(asset.fileName);
		await verifyExchangeFile(asset, file, signal);
	}
	const capacity = await storageService.canStoreFile({
		size: plan.payload.assets.reduce((sum, asset) => sum + asset.size, 0),
	});
	check();
	if (!capacity.canStore)
		throw new Error("Not enough browser storage to import this project");
	let prepared = await prepare(
		plan.payload.archive as CanonicalHistoryArchive,
		projectId,
	);
	check();
	let bundle = await validateExchangeBundle({
		plan,
		prepared,
		files: selections,
		accountId: scope.accountId,
		signal,
	});
	check();
	if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength > 120_000_000)
		throw new Error(
			"The project and saved artifacts exceed the session storage limit",
		);
	let published = false;
	let cleanupScope = scope;
	try {
		if (
			await localDriveRequest({
				operation: "project.get",
				payload: { projectId },
				scope,
			})
		)
			throw new Error("The new project identity is already in use");
		check();
		// New random identity only; source project and existing files are untouched.
		await localDriveRequest({
			operation: "project.put",
			payload: { projectId, project: prepared.classic.document },
			scope,
		});
		published = true;
		check();
		const sharedAudioIds: Record<string, string> = {},
			sharedStickerIds: Record<string, string> = {};
		for (const asset of plan.payload.assets) {
			check();
			onProgress?.(asset.fileName);
			const selected = selections.get(assetKey(asset))!;
			const file = new File([selected], asset.fileName, {
				type: asset.mimeType,
				lastModified: asset.lastModified,
			});
			if (asset.kind === "media") {
				const original = prepared.mediaAssets.find(
					(item) => item.id === asset.id,
				);
				if (!original)
					throw new Error(
						"Archive media is not owned by its canonical project",
					);
				await storageService.saveMediaAsset({
					projectId,
					scope,
					mediaAsset: {
						...original,
						file,
						sourcePath: undefined,
						storageKind: "copied",
						missing: false,
					},
				});
			} else if (asset.kind === "director") {
				const original = prepared.references.find(
					(item) => item.id === asset.id,
				);
				if (!original)
					throw new Error(
						"Archive reference is not owned by its canonical project",
					);
				await uploadArchiveReference({
					projectId,
					accountId: scope.accountId,
					id: asset.id,
					sha256: asset.sha256 ?? (await hashExchangeFile(file, signal)),
					file,
					name: original.name,
					storyboard: original.storyboard,
					signal,
				});
			} else if (asset.kind === "font") {
				await storageService.saveProjectFont({
					projectId,
					font: {
						...asset.metadata,
						id: asset.id,
						family: asset.name,
						fileName: asset.fileName,
						mimeType: asset.mimeType,
						size: file.size,
						lastModified: asset.lastModified,
						createdAt: String(
							asset.metadata.createdAt ?? plan.payload.exportedAt,
						),
						sourceUrl: undefined,
						repositoryPath: undefined,
						file,
					} as ProjectFontAsset,
				});
			} else if (
				asset.kind === "sharedAudio" ||
				asset.kind === "sharedSticker"
			) {
				const target = await importSharedExchangeAsset({
					kind: asset.kind,
					metadata: asset.metadata,
					file,
					signal,
				});
				(asset.kind === "sharedAudio" ? sharedAudioIds : sharedStickerIds)[
					asset.id
				] = target;
			}
		}
		for (const asset of prepared.mediaAssets.filter(
			(asset) => asset.unifiedAngles,
		)) {
			check();
			await storageService.saveMediaAsset({
				projectId,
				scope,
				mediaAsset: asset,
			});
		}
		check();
		if (
			Object.keys(sharedAudioIds).length ||
			Object.keys(sharedStickerIds).length
		)
			prepared = await prepare(
				plan.payload.archive as CanonicalHistoryArchive,
				projectId,
				{ sharedAudioIds, sharedStickerIds },
			);
		check();
		await localDriveRequest({
			operation: "project.put",
			payload: { projectId, project: prepared.classic.document },
			scope,
		});
		bundle = { ...bundle, archive: prepared.archive };
		check();
		const session = new EditorSessionClient({
			accountId: scope.accountId,
			projectId,
		});
		let commitStarted = false;
		try {
			await session.acquire({ expectedGeneration: 0 });
			cleanupScope = {
				...captureLocalDriveWriteScope({
					projectId,
					accountId: scope.accountId,
				}),
				signal,
			};
			signal?.throwIfAborted();
			try {
				commitStarted = true;
				await session.save(() => bundle);
			} catch (error) {
				if (error instanceof EditorSessionFailure && error.definitive)
					throw error;
				// A lost commit reply may already be durable. release reconciles the
				// same pending request before giving ownership to the eventual opener.
				await session.release();
				const view = await session.read();
				if (
					!view.saved ||
					view.saved.editorRevision !== bundle.archive.revision
				)
					throw error;
			}
			await session.release().catch(() => {});
		} catch (error) {
			// Only an uncertain commit may already contain a complete durable
			// project. Known rejection/acquire/cancellation failures are cleaned.
			if (
				commitStarted &&
				!(error instanceof EditorSessionFailure && error.definitive)
			)
				published = false;
			throw error;
		} finally {
			session.dispose();
		}
		return { projectId, projectName: plan.payload.projectName };
	} catch (error) {
		// Cleanup is pinned to the newly allocated account/project, never whichever
		// editor happened to become active while files were copied.
		if (published) {
			const cleanup = { ...cleanupScope, signal: undefined };
			await Promise.allSettled([
				localDriveRequest({
					operation: "media.clear",
					payload: { projectId },
					scope: cleanup,
				}),
				localDriveRequest({
					operation: "font.clear",
					payload: { projectId },
					scope: cleanup,
				}),
				localDriveRequest({
					operation: "history.delete",
					payload: { projectId },
					scope: cleanup,
				}),
				...(isHostedBrowserWorkspace()
					? [hostedMedia(projectId, scope.accountId).clear()]
					: []),
			]);
			await localDriveRequest({
				operation: "project.delete",
				payload: { projectId },
				scope: cleanup,
			}).catch(() => {});
		}
		throw error;
	}
}

export function downloadProjectExchange(
	blob: Blob,
	projectName: string,
	format: "xml" | "zip",
) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `${projectName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") || "POCUT project"}${format === "xml" ? ".pocut.xml" : ".opencut.zip"}`;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
