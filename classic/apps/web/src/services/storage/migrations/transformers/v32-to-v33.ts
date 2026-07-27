import type { MigrationResult, ProjectRecord } from "./types";
import { getProjectId, isRecord } from "./utils";

export function transformProjectV32ToV33({
	project,
}: {
	project: ProjectRecord;
}): MigrationResult<ProjectRecord> {
	if (!getProjectId({ project })) {
		return { project, skipped: true, reason: "no project id" };
	}

	const version = project.version;
	if (typeof version !== "number") {
		return { project, skipped: true, reason: "invalid version" };
	}
	if (version >= 33) {
		return { project, skipped: true, reason: "already v33" };
	}
	if (version !== 32) {
		return { project, skipped: true, reason: "not v32" };
	}

	return {
		project: {
			...migrateProject({ project }),
			version: 33,
		},
		skipped: false,
	};
}

function migrateProject({ project }: { project: ProjectRecord }): ProjectRecord {
	const nextProject = { ...project };
	if (Array.isArray(project.scenes)) {
		nextProject.scenes = project.scenes.map((scene) => migrateScene({ scene }));
	}
	return nextProject;
}

function migrateScene({ scene }: { scene: unknown }): unknown {
	if (!isRecord(scene) || !isRecord(scene.tracks)) {
		return scene;
	}

	return {
		...scene,
		tracks: migrateTracks({ tracks: scene.tracks }),
	};
}

function migrateTracks({ tracks }: { tracks: ProjectRecord }): ProjectRecord {
	return {
		...tracks,
		...(Array.isArray(tracks.overlay)
			? { overlay: tracks.overlay.map((track) => migrateTrack({ track })) }
			: {}),
		...(isRecord(tracks.main)
			? { main: migrateTrack({ track: tracks.main }) }
			: {}),
		...(Array.isArray(tracks.audio)
			? { audio: tracks.audio.map((track) => migrateTrack({ track })) }
			: {}),
	};
}

function migrateTrack({ track }: { track: unknown }): unknown {
	if (!isRecord(track) || !Array.isArray(track.elements)) {
		return track;
	}

	return {
		...track,
		elements: track.elements.map((element) => migrateElement({ element })),
	};
}

function migrateElement({ element }: { element: unknown }): unknown {
	if (
		!isRecord(element) ||
		element.type !== "audio" ||
		element.sourceType !== "library" ||
		typeof element.librarySourceType === "string"
	) {
		return element;
	}

	return {
		...element,
		librarySourceType:
			typeof element.libraryAssetId === "string" ? "shared" : "remote",
	};
}
