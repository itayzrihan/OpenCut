import type { MigrationResult, ProjectRecord } from "./types";
import { getProjectId, isRecord } from "./utils";

export function transformProjectV31ToV32({
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
	if (version >= 32) {
		return { project, skipped: true, reason: "already v32" };
	}
	if (version !== 31) {
		return { project, skipped: true, reason: "not v31" };
	}

	return {
		project: {
			...migrateProject({ project }),
			version: 32,
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
	const overlayIds = Array.isArray(tracks.overlay)
		? tracks.overlay.flatMap((track) => readTrackId({ track }))
		: [];
	const mainIds = readTrackId({ track: tracks.main });
	const audioIds = Array.isArray(tracks.audio)
		? tracks.audio.flatMap((track) => readTrackId({ track }))
		: [];

	return {
		...tracks,
		order: [...overlayIds, ...mainIds, ...audioIds],
	};
}

function readTrackId({ track }: { track: unknown }): string[] {
	if (!isRecord(track) || typeof track.id !== "string") {
		return [];
	}
	return [track.id];
}
