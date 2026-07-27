import type { ProjectFontData } from "@/services/storage/types";
import type {
	LocalDriveMediaRecord,
	LocalDriveOperation,
	LocalDriveStatus,
} from "./types";

const API_PATH = "/api/local-drive";

async function readError(response: Response): Promise<string> {
	try {
		const payload = (await response.json()) as { error?: unknown };
		if (typeof payload.error === "string") return payload.error;
	} catch {
		// Fall back to the HTTP status below.
	}
	return `Local-drive request failed (${response.status})`;
}

export async function localDriveRequest<T>({
	operation,
	payload = {},
}: {
	operation: LocalDriveOperation;
	payload?: Record<string, unknown>;
}): Promise<T> {
	const response = await fetch(API_PATH, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operation, ...payload }),
		cache: "no-store",
	});
	if (!response.ok) throw new Error(await readError(response));
	return (await response.json()) as T;
}

export function localMediaUrl({
	projectId,
	id,
}: {
	projectId: string;
	id: string;
}): string {
	const params = new URLSearchParams({ projectId, id });
	return `/api/local-drive/media?${params}`;
}

export function localFontUrl({
	projectId,
	id,
}: {
	projectId: string;
	id: string;
}): string {
	const params = new URLSearchParams({ projectId, id });
	return `/api/local-drive/font?${params}`;
}

export async function getLocalDriveStatus(): Promise<LocalDriveStatus> {
	return localDriveRequest({ operation: "status" });
}

export async function pickLocalMedia({
	projectId,
}: {
	projectId: string;
}): Promise<LocalDriveMediaRecord[]> {
	return localDriveRequest({ operation: "media.pick", payload: { projectId } });
}

export async function uploadLocalMedia({
	projectId,
	id,
	file,
	migration = false,
}: {
	projectId: string;
	id: string;
	file: File;
	migration?: boolean;
}): Promise<void> {
	const params = new URLSearchParams({
		projectId,
		id,
		fileName: file.name,
		mimeType: file.type || "application/octet-stream",
		lastModified: String(file.lastModified),
		size: String(file.size),
	});
	if (migration) params.set("migration", "1");
	const response = await fetch(`/api/local-drive/media?${params}`, {
		method: "POST",
		body: file,
	});
	if (!response.ok) throw new Error(await readError(response));
}

export async function uploadLocalFont({
	projectId,
	id,
	file,
}: {
	projectId: string;
	id: string;
	file: File;
}): Promise<string> {
	const params = new URLSearchParams({ projectId, id, fileName: file.name });
	const response = await fetch(`/api/local-drive/font?${params}`, {
		method: "POST",
		body: file,
	});
	if (!response.ok) throw new Error(await readError(response));
	const payload = (await response.json()) as { storedPath: string };
	return payload.storedPath;
}

export async function loadLocalFontFile({
	projectId,
	font,
}: {
	projectId: string;
	font: ProjectFontData;
}): Promise<File> {
	const response = await fetch(localFontUrl({ projectId, id: font.id }), {
		cache: "no-store",
	});
	if (!response.ok) throw new Error(await readError(response));
	const blob = await response.blob();
	return new File([blob], font.fileName, {
		type: font.mimeType || blob.type,
		lastModified: font.lastModified,
	});
}
