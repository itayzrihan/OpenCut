import { getKeyframeById } from "@/animation";
import type {
	AiEditPlanRecord,
	AiEditTargetRefs,
	TProject,
} from "@/project/types";
import type { TimelineElement, TimelineTrack, TScene } from "@/timeline/types";
import { addMediaTime, mediaTime, type MediaTime } from "@/wasm";
import { generateUUID } from "@/utils/id";
import type { AiEditOperation, AiEditPlan, AiTimelineRange } from "./types";
import { defaultAiEditPlanRecordBuilder } from "./edit-provenance-builder";

export interface AiEditOperationTimingDescriptor {
	startTime?: MediaTime;
	duration?: MediaTime;
	pointTime?: MediaTime;
}

export interface AiEditOperationDescriptor {
	operationId?: string;
	operationType: string;
	label?: string;
	reason?: string;
	timing?: AiEditOperationTimingDescriptor;
	refs: AiEditTargetRefs;
	tombstone?: boolean;
}

export interface AiEditPlanRecordBuildOptions {
	planId?: string;
	title: string;
	summary?: string;
	appliedAt?: string;
	sceneId?: string;
	defaultRange?: AiEditOperationTimingDescriptor;
	operations: AiEditOperationDescriptor[];
}

type RustAiEditPlanRecordBuilder = (
	options: AiEditPlanRecordBuildOptions,
) => unknown;

export function buildAiEditPlanRecordOptions({
	plan,
	scene,
	range,
	planId = generateUUID(),
	appliedAt = new Date().toISOString(),
}: {
	plan: AiEditPlan;
	scene: TScene;
	range?: AiTimelineRange | null;
	planId?: string;
	appliedAt?: string;
}): AiEditPlanRecordBuildOptions {
	return {
		planId,
		title: plan.title,
		summary: plan.summary,
		appliedAt,
		sceneId: scene.id,
		...(range
			? {
					defaultRange: rangeTiming({
						startTime: range.startTime,
						duration: mediaTime({
							ticks: Math.max(0, range.endTime - range.startTime),
						}),
					}),
				}
			: {}),
		operations: plan.operations.map((operation, index) =>
			buildOperationDescriptor({
				operation,
				operationId: `${planId}:operation:${index + 1}`,
				scene,
			}),
		),
	};
}

export function buildAiEditPlanProvenanceRecord({
	plan,
	scene,
	range,
	planId,
	appliedAt,
}: {
	plan: AiEditPlan;
	scene: TScene;
	range?: AiTimelineRange | null;
	planId?: string;
	appliedAt?: string;
}): AiEditPlanRecord {
	const builder: RustAiEditPlanRecordBuilder | undefined =
		defaultAiEditPlanRecordBuilder;
	if (typeof builder !== "function") {
		throw new Error(
			"buildAiEditPlanRecord is unavailable; rebuild the opencut-wasm package",
		);
	}

	const value = builder(
		buildAiEditPlanRecordOptions({
			plan,
			scene,
			range,
			planId,
			appliedAt,
		}),
	);
	if (!isAiEditPlanRecord(value)) {
		throw new Error("buildAiEditPlanRecord returned an invalid record shape");
	}
	return value;
}

export function appendAiEditPlanRecord({
	project,
	record,
	updatedAt = new Date(),
}: {
	project: TProject;
	record: AiEditPlanRecord;
	updatedAt?: Date;
}): TProject {
	return {
		...project,
		metadata: { ...project.metadata, updatedAt },
		aiEditHistory: [...(project.aiEditHistory ?? []), record],
	};
}

function buildOperationDescriptor({
	operation,
	operationId,
	scene,
}: {
	operation: AiEditOperation;
	operationId: string;
	scene: TScene;
}): AiEditOperationDescriptor {
	const label = getOperationLabel(operation);
	const base = {
		operationId,
		operationType: operation.type,
		...(operation.reason ? { reason: operation.reason } : {}),
		...(label ? { label } : {}),
	};
	const activeSceneRefs = { sceneId: scene.id };

	switch (operation.type) {
		case "apply_timeline_source_v2":
			return {
				...base,
				refs: activeSceneRefs,
				...(operation.scope
					? {
							timing: rangeTiming({
								startTime: operation.scope.startTime,
								duration: mediaTime({
									ticks: Math.max(
										0,
										operation.scope.endTime - operation.scope.startTime,
									),
								}),
							}),
						}
					: {}),
			};
		case "update_element":
		case "delete_element":
		case "duplicate_element":
		case "set_element_state":
		case "retime_element":
		case "set_background_removal": {
			const element = findElement({
				scene,
				trackId: operation.trackId,
				elementId: operation.elementId,
			});
			return {
				...base,
				refs: elementRefs({
					sceneId: scene.id,
					trackId: operation.trackId,
					elementId: operation.elementId,
				}),
				...(element ? { timing: elementTiming(element) } : {}),
			};
		}
		case "trim_element": {
			const element = findElement({
				scene,
				trackId: operation.trackId,
				elementId: operation.elementId,
			});
			const startTime = operation.startTime ?? element?.startTime;
			const duration = operation.duration ?? element?.duration;
			return {
				...base,
				refs: elementRefs({
					sceneId: scene.id,
					trackId: operation.trackId,
					elementId: operation.elementId,
				}),
				...(startTime !== undefined && duration !== undefined
					? { timing: rangeTiming({ startTime, duration }) }
					: {}),
			};
		}
		case "move_element": {
			const element = findElement({
				scene,
				trackId: operation.sourceTrackId,
				elementId: operation.elementId,
			});
			return {
				...base,
				refs: elementRefs({
					sceneId: scene.id,
					trackId: operation.targetTrackId,
					elementId: operation.elementId,
				}),
				...(element
					? {
							timing: rangeTiming({
								startTime: operation.startTime,
								duration: element.duration,
							}),
						}
					: { timing: pointTiming(operation.startTime) }),
			};
		}
		case "split_element":
			return {
				...base,
				refs: elementRefs({
					sceneId: scene.id,
					trackId: operation.trackId,
					elementId: operation.elementId,
				}),
				timing: pointTiming(operation.splitTime),
			};
		case "add_clip_effect":
		case "update_clip_effect_params":
		case "remove_clip_effect":
		case "set_clip_effect_enabled":
		case "reorder_clip_effect": {
			const element = findElement({
				scene,
				trackId: operation.trackId,
				elementId: operation.elementId,
			});
			const effectId =
				operation.type === "update_clip_effect_params" ||
				operation.type === "remove_clip_effect" ||
				operation.type === "set_clip_effect_enabled"
					? operation.effectId
					: undefined;
			return {
				...base,
				refs: elementRefs({
					sceneId: scene.id,
					trackId: operation.trackId,
					elementId: operation.elementId,
					effectId,
				}),
				...(element ? { timing: elementTiming(element) } : {}),
			};
		}
		case "attach_custom_edit": {
			const element = findElement({
				scene,
				trackId: operation.trackId,
				elementId: operation.elementId,
			});
			const timing =
				operation.startTime !== undefined && operation.duration !== undefined
					? rangeTiming({
							startTime: operation.startTime,
							duration: operation.duration,
						})
					: element
						? elementTiming(element)
						: undefined;
			return {
				...base,
				refs: elementRefs({
					sceneId: scene.id,
					trackId: operation.trackId,
					elementId: operation.elementId,
				}),
				...(timing ? { timing } : {}),
			};
		}
		case "upsert_keyframe": {
			const element = findElement({
				scene,
				trackId: operation.trackId,
				elementId: operation.elementId,
			});
			const pointTime = element
				? addMediaTime({ a: element.startTime, b: operation.time })
				: operation.time;
			return {
				...base,
				refs: elementRefs({
					sceneId: scene.id,
					trackId: operation.trackId,
					elementId: operation.elementId,
					keyframeId: operation.keyframeId,
					propertyPath: operation.propertyPath,
				}),
				timing: pointTiming(pointTime),
			};
		}
		case "remove_keyframe": {
			const element = findElement({
				scene,
				trackId: operation.trackId,
				elementId: operation.elementId,
			});
			const keyframe = getKeyframeById({
				animations: element?.animations,
				propertyPath: operation.propertyPath,
				keyframeId: operation.keyframeId,
			});
			return {
				...base,
				refs: elementRefs({
					sceneId: scene.id,
					trackId: operation.trackId,
					elementId: operation.elementId,
					keyframeId: operation.keyframeId,
					propertyPath: operation.propertyPath,
				}),
				...(element && keyframe
					? {
							timing: pointTiming(
								addMediaTime({
									a: element.startTime,
									b: keyframe.time,
								}),
							),
						}
					: element
						? { timing: elementTiming(element) }
						: {}),
			};
		}
		case "insert_text_element":
		case "insert_library_audio_element":
		case "insert_graphic_element":
		case "insert_html_element":
		case "insert_sticker_element":
		case "insert_effect_element":
			return {
				...base,
				refs: {
					...activeSceneRefs,
					...(operation.trackId ? { trackId: operation.trackId } : {}),
				},
				timing: rangeTiming({
					startTime: operation.startTime,
					duration: operation.duration,
				}),
			};
		case "insert_media_element":
			return {
				...base,
				refs: {
					...activeSceneRefs,
					...(operation.trackId ? { trackId: operation.trackId } : {}),
				},
				timing:
					operation.duration !== undefined
						? rangeTiming({
								startTime: operation.startTime,
								duration: operation.duration,
							})
						: pointTiming(operation.startTime),
			};
		case "add_track":
			return { ...base, refs: activeSceneRefs };
		case "remove_track":
		case "reorder_track":
		case "set_track_state": {
			const track = findTrack({ scene, trackId: operation.trackId });
			const timing = track ? trackTiming(track) : undefined;
			return {
				...base,
				refs: { ...activeSceneRefs, trackId: operation.trackId },
				...(timing ? { timing } : {}),
			};
		}
		case "apply_transition": {
			const element = findElement({
				scene,
				trackId: operation.trackId,
				elementId: operation.elementId,
			});
			return {
				...base,
				refs: elementRefs({
					sceneId: scene.id,
					trackId: operation.trackId,
					elementId: operation.elementId,
					transitionId: element?.transitions?.[operation.side]?.id,
				}),
				...(element ? { timing: elementTiming(element) } : {}),
			};
		}
		case "create_scene":
			return { ...base, refs: {} };
		case "rename_scene":
		case "delete_scene":
			return { ...base, refs: { sceneId: operation.sceneId } };
		case "set_project_settings":
		case "start_export_task":
		case "start_transcription_task":
			return { ...base, refs: {} };
		case "add_bookmark":
		case "update_bookmark":
		case "remove_bookmark":
			return {
				...base,
				refs: activeSceneRefs,
				timing: pointTiming(operation.time),
			};
		case "move_bookmark":
			return {
				...base,
				refs: activeSceneRefs,
				timing: pointTiming(operation.toTime),
			};
		default:
			// Forward-compatible fallback: Rust applies the reviewed range when a
			// newly added operation has no more precise adapter yet.
			return { ...base, refs: activeSceneRefs };
	}
}

function getOperationLabel(operation: AiEditOperation): string | undefined {
	switch (operation.type) {
		case "apply_timeline_source_v2":
			return "Apply full Timeline Source";
		case "attach_custom_edit":
			return operation.label;
		case "insert_text_element":
			return (
				operation.name ?? (operation.content.trim().slice(0, 80) || undefined)
			);
		case "insert_media_element":
		case "insert_library_audio_element":
		case "insert_graphic_element":
		case "insert_html_element":
		case "insert_sticker_element":
		case "insert_effect_element":
			return operation.name;
		case "create_scene":
		case "rename_scene":
			return operation.name;
		case "add_bookmark":
		case "update_bookmark":
			return operation.note;
		default:
			return undefined;
	}
}

function findTrack({
	scene,
	trackId,
}: {
	scene: TScene;
	trackId: string;
}): TimelineTrack | undefined {
	return [
		...scene.tracks.overlay,
		scene.tracks.main,
		...scene.tracks.audio,
	].find((track) => track.id === trackId);
}

function findElement({
	scene,
	trackId,
	elementId,
}: {
	scene: TScene;
	trackId: string;
	elementId: string;
}): TimelineElement | undefined {
	return findTrack({ scene, trackId })?.elements.find(
		(element) => element.id === elementId,
	);
}

function elementRefs({
	sceneId,
	trackId,
	elementId,
	effectId,
	transitionId,
	keyframeId,
	propertyPath,
}: AiEditTargetRefs & {
	sceneId: string;
	trackId: string;
	elementId: string;
}): AiEditTargetRefs {
	return {
		sceneId,
		trackId,
		elementId,
		...(effectId ? { effectId } : {}),
		...(transitionId ? { transitionId } : {}),
		...(keyframeId ? { keyframeId } : {}),
		...(propertyPath ? { propertyPath } : {}),
	};
}

function elementTiming(
	element: Pick<TimelineElement, "startTime" | "duration">,
): AiEditOperationTimingDescriptor {
	return rangeTiming({
		startTime: element.startTime,
		duration: element.duration,
	});
}

function trackTiming(
	track: TimelineTrack,
): AiEditOperationTimingDescriptor | undefined {
	if (track.elements.length === 0) return undefined;
	const startTime = mediaTime({
		ticks: Math.min(...track.elements.map((element) => element.startTime)),
	});
	const endTime = mediaTime({
		ticks: Math.max(
			...track.elements.map((element) => element.startTime + element.duration),
		),
	});
	return rangeTiming({
		startTime,
		duration: mediaTime({ ticks: Math.max(0, endTime - startTime) }),
	});
}

function rangeTiming({
	startTime,
	duration,
}: {
	startTime: MediaTime;
	duration: MediaTime;
}): AiEditOperationTimingDescriptor {
	return { startTime, duration };
}

function pointTiming(pointTime: MediaTime): AiEditOperationTimingDescriptor {
	return { pointTime };
}

function isAiEditPlanRecord(value: unknown): value is AiEditPlanRecord {
	if (!isRecord(value)) return false;
	return (
		isNonNegativeInteger(value.schemaVersion) &&
		typeof value.id === "string" &&
		typeof value.title === "string" &&
		typeof value.summary === "string" &&
		(value.appliedAt === undefined || typeof value.appliedAt === "string") &&
		(value.sceneId === undefined || typeof value.sceneId === "string") &&
		Array.isArray(value.layers) &&
		value.layers.every(isAiEditLayerRecord) &&
		isNonNegativeInteger(value.operationCount) &&
		isNonNegativeInteger(value.truncatedOperationCount)
	);
}

function isAiEditLayerRecord(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.operationType === "string" &&
		typeof value.label === "string" &&
		(value.reason === undefined || typeof value.reason === "string") &&
		isAiEditAnchor(value.anchor) &&
		Array.isArray(value.refs) &&
		value.refs.every(isAiEditTargetRefs) &&
		Array.isArray(value.operationIds) &&
		value.operationIds.every((id) => typeof id === "string") &&
		isNonNegativeInteger(value.operationCount) &&
		typeof value.tombstone === "boolean"
	);
}

function isAiEditAnchor(value: unknown): boolean {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	if (value.kind === "project") return true;
	if (value.kind === "point") return typeof value.time === "number";
	return (
		value.kind === "range" &&
		typeof value.startTime === "number" &&
		typeof value.duration === "number"
	);
}

function isAiEditTargetRefs(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return [
		"sceneId",
		"trackId",
		"elementId",
		"effectId",
		"transitionId",
		"keyframeId",
		"propertyPath",
	].every((key) => value[key] === undefined || typeof value[key] === "string");
}

function isNonNegativeInteger(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
