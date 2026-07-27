/* eslint-disable opencut/prefer-object-params -- Filesystem helpers intentionally mirror Node path operations. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import {
	basename,
	extname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
} from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { mediaLinkThresholdBytes, mediaStorageDisposition } from "opencut-wasm";
import type { ProjectFontData, MediaAssetData } from "@/services/storage/types";
import type {
	LocalDriveMediaRecord,
	LocalDriveStatus,
	MediaStorageKind,
} from "./types";

const execFileAsync = promisify(execFile);
const PROJECT_FILE = "project.json";
const HISTORY_FILE = "history.json";
const MEDIA_INDEX_FILE = "index.json";
const FONT_INDEX_FILE = "index.json";
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SHARED_COLLECTIONS = new Set([
	"audio",
	"stickers",
	"categories",
	"backgrounds",
	"effects",
	"caption-presets",
	"recovery-snapshots",
]);
const SHARED_FILE_KINDS = new Set(["audio", "stickers"]);

interface StoredMediaRecord extends MediaAssetData {
	fileName: string;
	mimeType: string;
	storageKind: MediaStorageKind;
	storedPath?: string;
	sourcePath?: string;
}

interface StoredFontRecord extends ProjectFontData {
	storedPath: string;
}

function driveRoot(): string {
	const configured = process.env.POCUT_PROJECTS_DIR?.trim();
	return resolve(configured || join(homedir(), "Movies", "PoCut Projects"));
}

function projectsRoot(): string {
	return join(driveRoot(), "projects");
}

function settingsRoot(): string {
	return join(driveRoot(), "settings");
}

function sharedRoot(): string {
	return join(driveRoot(), "shared-library");
}

function assertSharedCollection(collection: string): string {
	if (!SHARED_COLLECTIONS.has(collection))
		throw new Error("Invalid shared collection");
	return collection;
}

function assertSharedFileKind(kind: string): string {
	if (!SHARED_FILE_KINDS.has(kind)) throw new Error("Invalid shared file kind");
	return kind;
}

function assertSharedId(id: string): string {
	if (!id || id.length > 512 || id.includes("\0"))
		throw new Error("Invalid shared id");
	return id;
}

function assertId(id: string, label: string): string {
	if (!SAFE_ID.test(id)) {
		throw new Error(`Invalid ${label}`);
	}
	return id;
}

function projectRoot(projectId: string): string {
	return join(projectsRoot(), assertId(projectId, "project id"));
}

function mediaRoot(projectId: string): string {
	return join(projectRoot(projectId), "media");
}

function fontRoot(projectId: string): string {
	return join(projectRoot(projectId), "fonts");
}

function assertContainedPath({
	root,
	path,
}: {
	root: string;
	path: string;
}): string {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(path);
	const pathFromRoot = relative(resolvedRoot, resolvedPath);
	if (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
	) {
		return resolvedPath;
	}
	throw new Error("Stored path points outside the PoCut project folder");
}

function safeFileName(name: string, fallback: string): string {
	const withoutUnsafeCharacters = Array.from(name, (character) =>
		character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character)
			? "_"
			: character,
	).join("");
	const cleaned = withoutUnsafeCharacters.replace(/\s+/g, " ").trim();
	return cleaned || fallback;
}

async function ensureRoot(): Promise<void> {
	await Promise.all([
		mkdir(projectsRoot(), { recursive: true }),
		mkdir(settingsRoot(), { recursive: true }),
		mkdir(sharedRoot(), { recursive: true }),
	]);
}

async function readJson<T>({
	path,
	fallback,
}: {
	path: string;
	fallback: T;
}): Promise<T> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw error;
	}
}

async function writeJsonAtomic({
	path,
	value,
}: {
	path: string;
	value: unknown;
}) {
	await mkdir(resolve(path, ".."), { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		await rename(temporaryPath, path);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

function mediaIndexPath(projectId: string): string {
	return join(mediaRoot(projectId), MEDIA_INDEX_FILE);
}

function fontIndexPath(projectId: string): string {
	return join(fontRoot(projectId), FONT_INDEX_FILE);
}

async function readMediaIndex(projectId: string): Promise<StoredMediaRecord[]> {
	return readJson({ path: mediaIndexPath(projectId), fallback: [] });
}

async function writeMediaIndex(
	projectId: string,
	records: StoredMediaRecord[],
): Promise<void> {
	await writeJsonAtomic({ path: mediaIndexPath(projectId), value: records });
}

async function readFontIndex(projectId: string): Promise<StoredFontRecord[]> {
	return readJson({ path: fontIndexPath(projectId), fallback: [] });
}

async function writeFontIndex(
	projectId: string,
	records: StoredFontRecord[],
): Promise<void> {
	await writeJsonAtomic({ path: fontIndexPath(projectId), value: records });
}

const mutationQueues = new Map<string, Promise<void>>();

async function withMutationLock<T>(
	key: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = mutationQueues.get(key) ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(operation);
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	mutationQueues.set(key, settled);
	try {
		return await run;
	} finally {
		if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
	}
}

async function mutateMediaIndex(
	projectId: string,
	mutate: (
		records: StoredMediaRecord[],
	) => Promise<StoredMediaRecord[]> | StoredMediaRecord[],
): Promise<void> {
	await withMutationLock(mediaIndexPath(projectId), async () => {
		const records = await readMediaIndex(projectId);
		await writeMediaIndex(projectId, await mutate(records));
	});
}

async function mutateFontIndex(
	projectId: string,
	mutate: (
		records: StoredFontRecord[],
	) => Promise<StoredFontRecord[]> | StoredFontRecord[],
): Promise<void> {
	await withMutationLock(fontIndexPath(projectId), async () => {
		const records = await readFontIndex(projectId);
		await writeFontIndex(projectId, await mutate(records));
	});
}

function mimeTypeForPath(path: string): string {
	const extension = extname(path).toLowerCase();
	const mimeTypes: Record<string, string> = {
		".mp4": "video/mp4",
		".mov": "video/quicktime",
		".m4v": "video/x-m4v",
		".webm": "video/webm",
		".mkv": "video/x-matroska",
		".avi": "video/x-msvideo",
		".mp3": "audio/mpeg",
		".wav": "audio/wav",
		".m4a": "audio/mp4",
		".aac": "audio/aac",
		".flac": "audio/flac",
		".ogg": "audio/ogg",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".webp": "image/webp",
		".gif": "image/gif",
		".svg": "image/svg+xml",
		".bmp": "image/bmp",
		".avif": "image/avif",
		".ttf": "font/ttf",
		".otf": "font/otf",
		".woff": "font/woff",
		".woff2": "font/woff2",
	};
	return mimeTypes[extension] ?? "application/octet-stream";
}

function disposition({
	size,
	hasSourcePath,
	preserveLink = false,
}: {
	size: number;
	hasSourcePath: boolean;
	preserveLink?: boolean;
}): "copy" | "link" | "sourcePathRequired" {
	return mediaStorageDisposition({
		size,
		hasSourcePath,
		preserveLink,
	}) as "copy" | "link" | "sourcePathRequired";
}

export function assertLocalDriveRequest(request: Request): void {
	const host = new URL(request.url).hostname.replace(/^\[|\]$/g, "");
	if (!host || !["localhost", "127.0.0.1", "::1"].includes(host)) {
		throw new Error("Local-drive storage is available only from localhost");
	}
	const fetchSite = request.headers.get("sec-fetch-site");
	if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
		throw new Error("Cross-site local-drive requests are not allowed");
	}
}

export async function getLocalDriveStatus(): Promise<LocalDriveStatus> {
	await ensureRoot();
	return {
		rootPath: driveRoot(),
		mediaLinkThresholdBytes: mediaLinkThresholdBytes(),
	};
}

export async function listProjects(): Promise<unknown[]> {
	await ensureRoot();
	const entries = await readdir(projectsRoot(), { withFileTypes: true });
	const projects = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
			.map((entry) =>
				readJson<unknown | null>({
					path: join(projectsRoot(), entry.name, PROJECT_FILE),
					fallback: null,
				}),
			),
	);
	return projects.filter((project) => project !== null);
}

export async function getProject(projectId: string): Promise<unknown | null> {
	return readJson({
		path: join(projectRoot(projectId), PROJECT_FILE),
		fallback: null,
	});
}

export async function putProject(projectId: string, project: unknown) {
	await writeJsonAtomic({
		path: join(projectRoot(projectId), PROJECT_FILE),
		value: project,
	});
}

export async function deleteProject(projectId: string) {
	await rm(projectRoot(projectId), { recursive: true, force: true });
}

export async function getHistory(projectId: string): Promise<unknown | null> {
	return readJson({
		path: join(projectRoot(projectId), HISTORY_FILE),
		fallback: null,
	});
}

export async function putHistory(projectId: string, history: unknown) {
	await writeJsonAtomic({
		path: join(projectRoot(projectId), HISTORY_FILE),
		value: history,
	});
}

export async function deleteHistory(projectId: string) {
	await rm(join(projectRoot(projectId), HISTORY_FILE), { force: true });
}

function storedMediaPath(projectId: string, record: StoredMediaRecord): string {
	if (record.storageKind === "linked") {
		if (!record.sourcePath || !isAbsolute(record.sourcePath)) {
			throw new Error(`Linked media ${record.id} has no valid source path`);
		}
		return normalize(record.sourcePath);
	}
	if (!record.storedPath) {
		throw new Error(`Copied media ${record.id} has no stored path`);
	}
	return assertContainedPath({
		root: projectRoot(projectId),
		path: join(projectRoot(projectId), record.storedPath),
	});
}

function clientMediaRecord(
	projectId: string,
	record: StoredMediaRecord,
): LocalDriveMediaRecord {
	const sourcePath = storedMediaPath(projectId, record);
	return {
		...record,
		sourcePath,
		missing: !existsSync(sourcePath),
	};
}

export async function listMedia(
	projectId: string,
): Promise<LocalDriveMediaRecord[]> {
	return (await readMediaIndex(projectId)).map((record) =>
		clientMediaRecord(projectId, record),
	);
}

export async function getMediaFile(projectId: string, mediaId: string) {
	assertId(mediaId, "media id");
	const record = (await readMediaIndex(projectId)).find(
		(item) => item.id === mediaId,
	);
	if (!record) return null;
	const path = storedMediaPath(projectId, record);
	const fileStat = await stat(path).catch(() => null);
	if (!fileStat?.isFile()) return null;
	return { path, record, stat: fileStat };
}

export async function putMediaMetadata(
	projectId: string,
	metadata: LocalDriveMediaRecord,
) {
	assertId(metadata.id, "media id");
	await mutateMediaIndex(projectId, (records) => {
		const index = records.findIndex((item) => item.id === metadata.id);
		if (index < 0) {
			throw new Error("Media bytes or source path must be registered first");
		}
		const existing = records[index];
		records[index] = {
			...existing,
			id: metadata.id,
			name: metadata.name,
			type: metadata.type,
			size: metadata.size,
			lastModified: metadata.lastModified,
			width: metadata.width,
			height: metadata.height,
			duration: metadata.duration,
			fps: metadata.fps,
			hasAudio: metadata.hasAudio,
			thumbnailUrl: metadata.thumbnailUrl,
			ephemeral: metadata.ephemeral,
			fileName: metadata.fileName || existing.fileName,
			mimeType: metadata.mimeType || existing.mimeType,
		};
		return records;
	});
}

export async function registerMediaPath({
	projectId,
	record,
	preserveLink = false,
}: {
	projectId: string;
	record: LocalDriveMediaRecord;
	preserveLink?: boolean;
}): Promise<LocalDriveMediaRecord> {
	assertId(record.id, "media id");
	if (!record.sourcePath || !isAbsolute(record.sourcePath)) {
		throw new Error("A valid absolute source path is required");
	}
	const sourcePath = normalize(record.sourcePath);
	const sourceStat = await stat(sourcePath);
	if (!sourceStat.isFile()) throw new Error("Media source is not a file");
	const storageDisposition = disposition({
		size: sourceStat.size,
		hasSourcePath: true,
		preserveLink,
	});
	const baseRecord: StoredMediaRecord = {
		...record,
		size: sourceStat.size,
		lastModified: sourceStat.mtimeMs,
		fileName: safeFileName(record.fileName || basename(sourcePath), record.id),
		mimeType: record.mimeType || mimeTypeForPath(sourcePath),
		storageKind: storageDisposition === "link" ? "linked" : "copied",
	};
	delete (baseRecord as Partial<LocalDriveMediaRecord>).missing;

	if (storageDisposition === "link") {
		baseRecord.sourcePath = sourcePath;
		delete baseRecord.storedPath;
	} else {
		const fileName = `${record.id}--${safeFileName(baseRecord.fileName, record.id)}`;
		const destination = join(mediaRoot(projectId), "files", fileName);
		await mkdir(resolve(destination, ".."), { recursive: true });
		if (resolve(sourcePath) !== resolve(destination)) {
			await copyFile(sourcePath, destination);
		}
		baseRecord.storedPath = relative(projectRoot(projectId), destination);
		delete baseRecord.sourcePath;
	}

	await mutateMediaIndex(projectId, async (records) => {
		const oldRecord = records.find((item) => item.id === record.id);
		if (
			oldRecord?.storageKind === "copied" &&
			oldRecord.storedPath &&
			oldRecord.storedPath !== baseRecord.storedPath
		) {
			await rm(
				assertContainedPath({
					root: projectRoot(projectId),
					path: join(projectRoot(projectId), oldRecord.storedPath),
				}),
				{ force: true },
			).catch(() => undefined);
		}
		return [...records.filter((item) => item.id !== record.id), baseRecord];
	});
	return clientMediaRecord(projectId, baseRecord);
}

export async function storeUploadedMedia({
	projectId,
	mediaId,
	fileName,
	mimeType,
	lastModified,
	size,
	body,
	allowLargeCopy,
}: {
	projectId: string;
	mediaId: string;
	fileName: string;
	mimeType: string;
	lastModified: number;
	size: number;
	body: ReadableStream<Uint8Array>;
	allowLargeCopy: boolean;
}): Promise<void> {
	assertId(mediaId, "media id");
	if (
		!allowLargeCopy &&
		disposition({ size, hasSourcePath: false }) === "sourcePathRequired"
	) {
		throw new Error(
			"Files larger than 1 GB must be imported with the drive picker",
		);
	}
	const cleanedName = safeFileName(fileName, mediaId);
	const destination = join(
		mediaRoot(projectId),
		"files",
		`${mediaId}--${cleanedName}`,
	);
	const temporaryPath = `${destination}.${randomUUID()}.tmp`;
	await mkdir(resolve(destination, ".."), { recursive: true });
	try {
		await pipeline(
			Readable.fromWeb(body as never),
			createWriteStream(temporaryPath, { flags: "wx" }),
		);
		const written = await stat(temporaryPath);
		if (Number.isFinite(size) && size >= 0 && written.size !== size) {
			throw new Error("Uploaded media size did not match the file metadata");
		}
		await rename(temporaryPath, destination);
		const base: StoredMediaRecord = {
			id: mediaId,
			name: cleanedName,
			type: mimeType.startsWith("image/")
				? "image"
				: mimeType.startsWith("audio/")
					? "audio"
					: "video",
			size: written.size,
			lastModified,
			fileName: cleanedName,
			mimeType: mimeType || mimeTypeForPath(cleanedName),
			storageKind: "copied",
			storedPath: relative(projectRoot(projectId), destination),
		};
		await mutateMediaIndex(projectId, (records) => [
			...records.filter((item) => item.id !== mediaId),
			base,
		]);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

export async function deleteMedia(projectId: string, mediaId: string) {
	assertId(mediaId, "media id");
	// Keep copied bytes in the project folder so the editor's immediate Undo can
	// restore the media record without another browser-sized upload. Project
	// deletion and Clear Media still remove the entire media directory.
	await mutateMediaIndex(projectId, (records) =>
		records.filter((item) => item.id !== mediaId),
	);
}

export async function clearMedia(projectId: string) {
	await rm(mediaRoot(projectId), { recursive: true, force: true });
}

async function chooseFiles(): Promise<string[]> {
	const currentPlatform = platform();
	try {
		if (currentPlatform === "darwin") {
			const script = [
				'set chosenFiles to choose file with prompt "Import media into PoCut" with multiple selections allowed',
				'set output to ""',
				"repeat with chosenFile in chosenFiles",
				"set output to output & POSIX path of chosenFile & linefeed",
				"end repeat",
				"return output",
			].join("\n");
			const { stdout } = await execFileAsync("osascript", ["-e", script], {
				maxBuffer: 1024 * 1024,
			});
			return stdout
				.split("\n")
				.map((path) => path.trim())
				.filter(Boolean);
		}
		if (currentPlatform === "win32") {
			const script = [
				"Add-Type -AssemblyName System.Windows.Forms",
				"$dialog = New-Object System.Windows.Forms.OpenFileDialog",
				"$dialog.Multiselect = $true",
				"if ($dialog.ShowDialog() -eq 'OK') { $dialog.FileNames -join \"`n\" }",
			].join("; ");
			const { stdout } = await execFileAsync(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-Command", script],
				{ maxBuffer: 1024 * 1024 },
			);
			return stdout
				.split(/\r?\n/)
				.map((path) => path.trim())
				.filter(Boolean);
		}
		const { stdout } = await execFileAsync(
			"zenity",
			[
				"--file-selection",
				"--multiple",
				"--separator=\n",
				"--title=Import media into PoCut",
			],
			{ maxBuffer: 1024 * 1024 },
		);
		return stdout
			.split("\n")
			.map((path) => path.trim())
			.filter(Boolean);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/cancel|canceled|cancelled|(-128)|exit code 1/i.test(message))
			return [];
		throw new Error(`Could not open the system file picker: ${message}`);
	}
}

export async function pickAndRegisterMedia(
	projectId: string,
): Promise<LocalDriveMediaRecord[]> {
	const paths = await chooseFiles();
	const results: LocalDriveMediaRecord[] = [];
	for (const sourcePath of paths) {
		const sourceStat = await stat(sourcePath);
		if (!sourceStat.isFile()) continue;
		const id = randomUUID();
		const mimeType = mimeTypeForPath(sourcePath);
		const type = mimeType.startsWith("image/")
			? "image"
			: mimeType.startsWith("audio/")
				? "audio"
				: mimeType.startsWith("video/")
					? "video"
					: null;
		if (!type) continue;
		results.push(
			await registerMediaPath({
				projectId,
				record: {
					id,
					name: basename(sourcePath),
					type,
					size: sourceStat.size,
					lastModified: sourceStat.mtimeMs,
					fileName: basename(sourcePath),
					mimeType,
					storageKind: "copied",
					sourcePath,
				},
			}),
		);
	}
	return results;
}

export async function getFontFile(projectId: string, fontId: string) {
	assertId(fontId, "font id");
	const record = (await readFontIndex(projectId)).find(
		(item) => item.id === fontId,
	);
	if (!record) return null;
	const path = assertContainedPath({
		root: projectRoot(projectId),
		path: join(projectRoot(projectId), record.storedPath),
	});
	const fileStat = await stat(path).catch(() => null);
	if (!fileStat?.isFile()) return null;
	return { path, record, stat: fileStat };
}

export async function listFonts(projectId: string): Promise<ProjectFontData[]> {
	return readFontIndex(projectId);
}

export async function storeUploadedFont({
	projectId,
	fontId,
	fileName,
	body,
}: {
	projectId: string;
	fontId: string;
	fileName: string;
	body: ReadableStream<Uint8Array>;
}) {
	assertId(fontId, "font id");
	const destination = join(
		fontRoot(projectId),
		"files",
		`${fontId}--${safeFileName(fileName, fontId)}`,
	);
	const temporaryPath = `${destination}.${randomUUID()}.tmp`;
	await mkdir(resolve(destination, ".."), { recursive: true });
	try {
		await pipeline(
			Readable.fromWeb(body as never),
			createWriteStream(temporaryPath, { flags: "wx" }),
		);
		await rename(temporaryPath, destination);
		return relative(projectRoot(projectId), destination);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

export async function putFontMetadata(
	projectId: string,
	font: ProjectFontData,
	storedPath?: string,
) {
	assertId(font.id, "font id");
	await mutateFontIndex(projectId, (records) => {
		const existing = records.find((item) => item.id === font.id);
		const path = storedPath ?? existing?.storedPath;
		if (!path) throw new Error("Font bytes must be stored before metadata");
		return [
			...records.filter((item) => item.id !== font.id),
			{ ...font, storedPath: path },
		];
	});
}

export async function deleteFont(projectId: string, fontId: string) {
	await mutateFontIndex(projectId, async (records) => {
		const record = records.find((item) => item.id === fontId);
		if (record) {
			await rm(
				assertContainedPath({
					root: projectRoot(projectId),
					path: join(projectRoot(projectId), record.storedPath),
				}),
				{ force: true },
			);
		}
		return records.filter((item) => item.id !== fontId);
	});
}

export async function clearFonts(projectId: string) {
	await rm(fontRoot(projectId), { recursive: true, force: true });
}

export async function getSavedSounds(): Promise<unknown | null> {
	return readJson({
		path: join(settingsRoot(), "saved-sounds.json"),
		fallback: null,
	});
}

export async function putSavedSounds(value: unknown) {
	await writeJsonAtomic({
		path: join(settingsRoot(), "saved-sounds.json"),
		value,
	});
}

export async function deleteSavedSounds() {
	await rm(join(settingsRoot(), "saved-sounds.json"), { force: true });
}

function sharedCollectionPath(collection: string): string {
	return join(
		sharedRoot(),
		"metadata",
		`${assertSharedCollection(collection)}.json`,
	);
}

async function mutateSharedRecords(
	collection: string,
	mutate: (
		records: Array<Record<string, unknown>>,
	) => Array<Record<string, unknown>>,
): Promise<void> {
	const path = sharedCollectionPath(collection);
	await withMutationLock(path, async () => {
		const records = await readJson<Array<Record<string, unknown>>>({
			path,
			fallback: [],
		});
		await writeJsonAtomic({ path, value: mutate(records) });
	});
}

export async function listSharedRecords(
	collection: string,
): Promise<unknown[]> {
	return readJson({ path: sharedCollectionPath(collection), fallback: [] });
}

export async function getSharedRecord(collection: string, id: string) {
	assertSharedId(id);
	const records = (await listSharedRecords(collection)) as Array<
		Record<string, unknown>
	>;
	return records.find((record) => record.id === id) ?? null;
}

export async function putSharedRecord(
	collection: string,
	id: string,
	value: unknown,
) {
	assertSharedId(id);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Shared records must be JSON objects");
	}
	const record = { ...(value as Record<string, unknown>), id };
	await mutateSharedRecords(collection, (records) => [
		...records.filter((item) => item.id !== id),
		record,
	]);
}

export async function deleteSharedRecord(collection: string, id: string) {
	assertSharedId(id);
	await mutateSharedRecords(collection, (records) =>
		records.filter((record) => record.id !== id),
	);
}

export async function clearSharedRecords(collection: string) {
	const path = sharedCollectionPath(collection);
	await withMutationLock(path, () => rm(path, { force: true }));
}

function sharedFilesRoot(kind: string): string {
	return join(sharedRoot(), "files", assertSharedFileKind(kind));
}

function sharedFilePath(kind: string, id: string): string {
	return join(sharedFilesRoot(kind), encodeURIComponent(assertSharedId(id)));
}

export async function listSharedFileIds(kind: string): Promise<string[]> {
	const root = sharedFilesRoot(kind);
	const entries = await readdir(root, { withFileTypes: true }).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		},
	);
	return entries
		.filter((entry) => entry.isFile())
		.flatMap((entry) => {
			try {
				return [decodeURIComponent(entry.name)];
			} catch {
				return [];
			}
		});
}

export async function getSharedFile(kind: string, id: string) {
	const path = sharedFilePath(kind, id);
	const fileStat = await stat(path).catch(() => null);
	if (!fileStat?.isFile()) return null;
	return { path, stat: fileStat };
}

export async function storeSharedFile({
	kind,
	id,
	body,
}: {
	kind: string;
	id: string;
	body: ReadableStream<Uint8Array>;
}) {
	const destination = sharedFilePath(kind, id);
	const temporaryPath = `${destination}.${randomUUID()}.tmp`;
	await mkdir(resolve(destination, ".."), { recursive: true });
	try {
		await pipeline(
			Readable.fromWeb(body as never),
			createWriteStream(temporaryPath, { flags: "wx" }),
		);
		await rename(temporaryPath, destination);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

export async function deleteSharedFile(kind: string, id: string) {
	await rm(sharedFilePath(kind, id), { force: true });
}

export async function clearSharedFiles(kind: string) {
	await rm(sharedFilesRoot(kind), { recursive: true, force: true });
}

function preferencePath(key: string): string {
	const digest = createHash("sha256").update(key).digest("hex");
	return join(settingsRoot(), "preferences", `${digest}.json`);
}

export async function listPreferences(): Promise<Record<string, string>> {
	const root = join(settingsRoot(), "preferences");
	const entries = await readdir(root, { withFileTypes: true }).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		},
	);
	const records = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) =>
				readJson<{ key?: unknown; value?: unknown } | null>({
					path: join(root, entry.name),
					fallback: null,
				}),
			),
	);
	return Object.fromEntries(
		records.flatMap((record) =>
			typeof record?.key === "string" && typeof record.value === "string"
				? [[record.key, record.value]]
				: [],
		),
	);
}

export async function putPreference(key: string, value: string) {
	if (!key || key.length > 256) throw new Error("Invalid preference key");
	await writeJsonAtomic({ path: preferencePath(key), value: { key, value } });
}

export async function deletePreference(key: string) {
	await rm(preferencePath(key), { force: true });
}

export async function clearAllDriveData() {
	await Promise.all([
		rm(projectsRoot(), { recursive: true, force: true }),
		rm(settingsRoot(), { recursive: true, force: true }),
		rm(sharedRoot(), { recursive: true, force: true }),
	]);
	await ensureRoot();
}

export { createReadStream };
