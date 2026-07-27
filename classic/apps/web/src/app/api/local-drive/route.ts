/* eslint-disable opencut/prefer-object-params -- Route dispatch mirrors storage operation signatures. */
import { NextResponse } from "next/server";
import {
	assertLocalDriveRequest,
	clearAllDriveData,
	clearFonts,
	clearMedia,
	deleteFont,
	deleteHistory,
	deleteMedia,
	deleteProject,
	deleteSavedSounds,
	clearSharedFiles,
	clearSharedRecords,
	deleteSharedFile,
	deleteSharedRecord,
	deletePreference,
	getHistory,
	getLocalDriveStatus,
	getProject,
	getSavedSounds,
	getSharedRecord,
	listFonts,
	listMedia,
	listProjects,
	listSharedFileIds,
	listSharedRecords,
	listPreferences,
	pickAndRegisterMedia,
	putFontMetadata,
	putHistory,
	putMediaMetadata,
	putProject,
	putSavedSounds,
	putSharedRecord,
	putPreference,
	registerMediaPath,
} from "@/services/local-drive/server";
import type { LocalDriveOperation } from "@/services/local-drive/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} is required`);
	}
	return value;
}

export async function GET(request: Request) {
	try {
		assertLocalDriveRequest(request);
		return NextResponse.json(await getLocalDriveStatus(), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 403 },
		);
	}
}

export async function POST(request: Request) {
	try {
		assertLocalDriveRequest(request);
		const body = (await request.json()) as Record<string, unknown>;
		const operation = readString(
			body.operation,
			"operation",
		) as LocalDriveOperation;
		const projectId = () => readString(body.projectId, "projectId");
		const collection = () => readString(body.collection, "collection");
		const kind = () => readString(body.kind, "kind");

		switch (operation) {
			case "status":
				return NextResponse.json(await getLocalDriveStatus());
			case "project.list":
				return NextResponse.json(await listProjects());
			case "project.get":
				return NextResponse.json(await getProject(projectId()));
			case "project.put":
				await putProject(projectId(), body.project);
				return NextResponse.json({ ok: true });
			case "project.delete":
				await deleteProject(projectId());
				return NextResponse.json({ ok: true });
			case "history.get":
				return NextResponse.json(await getHistory(projectId()));
			case "history.put":
				await putHistory(projectId(), body.history);
				return NextResponse.json({ ok: true });
			case "history.delete":
				await deleteHistory(projectId());
				return NextResponse.json({ ok: true });
			case "media.list":
				return NextResponse.json(await listMedia(projectId()));
			case "media.put":
				await putMediaMetadata(
					projectId(),
					body.media as Parameters<typeof putMediaMetadata>[1],
				);
				return NextResponse.json({ ok: true });
			case "media.registerPath":
				return NextResponse.json(
					await registerMediaPath({
						projectId: projectId(),
						record: body.media as Parameters<
							typeof registerMediaPath
						>[0]["record"],
						preserveLink: body.preserveLink === true,
					}),
				);
			case "media.pick":
				return NextResponse.json(await pickAndRegisterMedia(projectId()));
			case "media.delete":
				await deleteMedia(projectId(), readString(body.id, "media id"));
				return NextResponse.json({ ok: true });
			case "media.clear":
				await clearMedia(projectId());
				return NextResponse.json({ ok: true });
			case "font.list":
				return NextResponse.json(await listFonts(projectId()));
			case "font.put":
				await putFontMetadata(
					projectId(),
					body.font as Parameters<typeof putFontMetadata>[1],
					typeof body.storedPath === "string" ? body.storedPath : undefined,
				);
				return NextResponse.json({ ok: true });
			case "font.delete":
				await deleteFont(projectId(), readString(body.id, "font id"));
				return NextResponse.json({ ok: true });
			case "font.clear":
				await clearFonts(projectId());
				return NextResponse.json({ ok: true });
			case "sounds.get":
				return NextResponse.json(await getSavedSounds());
			case "sounds.put":
				await putSavedSounds(body.sounds);
				return NextResponse.json({ ok: true });
			case "sounds.delete":
				await deleteSavedSounds();
				return NextResponse.json({ ok: true });
			case "shared.list":
				return NextResponse.json(await listSharedRecords(collection()));
			case "shared.get":
				return NextResponse.json(
					await getSharedRecord(collection(), readString(body.id, "record id")),
				);
			case "shared.put":
				await putSharedRecord(
					collection(),
					readString(body.id, "record id"),
					body.value,
				);
				return NextResponse.json({ ok: true });
			case "shared.delete":
				await deleteSharedRecord(
					collection(),
					readString(body.id, "record id"),
				);
				return NextResponse.json({ ok: true });
			case "shared.clear":
				await clearSharedRecords(collection());
				return NextResponse.json({ ok: true });
			case "sharedFile.list":
				return NextResponse.json(await listSharedFileIds(kind()));
			case "sharedFile.delete":
				await deleteSharedFile(kind(), readString(body.id, "file id"));
				return NextResponse.json({ ok: true });
			case "sharedFile.clear":
				await clearSharedFiles(kind());
				return NextResponse.json({ ok: true });
			case "preferences.list":
				return NextResponse.json(await listPreferences());
			case "preferences.put":
				if (typeof body.value !== "string") {
					throw new Error("preference value is required");
				}
				await putPreference(readString(body.key, "preference key"), body.value);
				return NextResponse.json({ ok: true });
			case "preferences.delete":
				await deletePreference(readString(body.key, "preference key"));
				return NextResponse.json({ ok: true });
			case "all.clear":
				await clearAllDriveData();
				return NextResponse.json({ ok: true });
			default:
				return NextResponse.json(
					{ error: `Unknown local-drive operation: ${operation}` },
					{ status: 400 },
				);
		}
	} catch (error) {
		console.error("Local-drive operation failed", error);
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 400 },
		);
	}
}
