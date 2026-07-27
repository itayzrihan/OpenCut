import type { AiEditAnchor, AiEditTargetRefs } from "@/project/types";
import { mediaTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

type UnknownRecord = Record<string, unknown>;

export interface AiEditTimelineItem {
	key: string;
	planId: string;
	layerId: string;
	planTitle: string;
	label: string;
	reason?: string;
	operationType: string;
	operationCount: number;
	tombstone: boolean;
	anchor: AiEditAnchor;
	seekTime: MediaTime;
}

function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString({
	value,
	maxCharacters = 256,
}: {
	value: unknown;
	maxCharacters?: number;
}): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().slice(0, maxCharacters);
	return trimmed.length > 0 ? trimmed : undefined;
}

function nonNegativeMediaTime(value: unknown): MediaTime | null {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
	return mediaTime({ ticks: Math.max(0, value) });
}

function normalizeAnchor(value: unknown): AiEditAnchor | null {
	if (!isRecord(value)) return null;
	if (value.kind === "project") return { kind: "project" };

	if (value.kind === "point") {
		const time = nonNegativeMediaTime(value.time);
		return time === null ? null : { kind: "point", time };
	}

	if (value.kind !== "range") return null;
	const startTime = nonNegativeMediaTime(value.startTime);
	const rawDuration = nonNegativeMediaTime(value.duration);
	if (startTime === null || rawDuration === null) return null;
	const safeDuration = Math.min(
		rawDuration,
		Number.MAX_SAFE_INTEGER - startTime,
	);
	if (safeDuration <= 0) {
		return { kind: "point", time: startTime };
	}

	return {
		kind: "range",
		startTime,
		duration: mediaTime({ ticks: safeDuration }),
	};
}

function normalizeRefs(layer: UnknownRecord): AiEditTargetRefs[] {
	const rawRefs = Array.isArray(layer.refs)
		? layer.refs
		: isRecord(layer.targetRefs)
			? [layer.targetRefs]
			: [];

	return rawRefs.flatMap((value) => {
		if (!isRecord(value)) return [];
		const refs: AiEditTargetRefs = {
			sceneId: optionalString({ value: value.sceneId }),
			trackId: optionalString({ value: value.trackId }),
			elementId: optionalString({ value: value.elementId }),
			effectId: optionalString({ value: value.effectId }),
			transitionId: optionalString({ value: value.transitionId }),
			keyframeId: optionalString({ value: value.keyframeId }),
			propertyPath: optionalString({ value: value.propertyPath }),
		};
		return Object.values(refs).some(Boolean) ? [refs] : [];
	});
}

function layerBelongsToScene({
	planSceneId,
	refs,
	activeSceneId,
}: {
	planSceneId?: string;
	refs: AiEditTargetRefs[];
	activeSceneId: string | null;
}): boolean {
	if (!activeSceneId) return true;
	if (planSceneId && planSceneId !== activeSceneId) return false;

	const referencedSceneIds = refs.flatMap((refs) =>
		refs.sceneId ? [refs.sceneId] : [],
	);
	return (
		referencedSceneIds.length === 0 ||
		referencedSceneIds.includes(activeSceneId)
	);
}

function defaultLayerLabel(operationType: string): string {
	if (!operationType) return "AI edit";
	const words = operationType.replaceAll(/[_-]+/g, " ");
	return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function isInferredTombstone(operationType: string): boolean {
	return /^(delete|remove)(_|-)/.test(operationType);
}

/**
 * Treat persisted project data as untrusted. Older projects used a singular
 * `targetRefs` field and omitted reducer metadata; both shapes remain visible.
 */
export function getAiEditTimelineItems({
	history,
	activeSceneId,
}: {
	history: unknown;
	activeSceneId: string | null;
}): AiEditTimelineItem[] {
	if (!Array.isArray(history)) return [];

	const items: AiEditTimelineItem[] = [];
	for (const [planIndex, rawPlan] of history.entries()) {
		if (!isRecord(rawPlan) || !Array.isArray(rawPlan.layers)) continue;
		const planId =
			optionalString({ value: rawPlan.id, maxCharacters: 160 }) ??
			`legacy-plan-${planIndex}`;
		const planTitle =
			optionalString({ value: rawPlan.title, maxCharacters: 160 }) ?? "AI edit";
		const planSceneId = optionalString({ value: rawPlan.sceneId });

		for (const [layerIndex, rawLayer] of rawPlan.layers.entries()) {
			if (!isRecord(rawLayer)) continue;
			const anchor = normalizeAnchor(rawLayer.anchor);
			if (!anchor) continue;
			const refs = normalizeRefs(rawLayer);
			if (
				!layerBelongsToScene({
					planSceneId,
					refs,
					activeSceneId,
				})
			) {
				continue;
			}

			const layerId =
				optionalString({ value: rawLayer.id, maxCharacters: 160 }) ??
				`legacy-layer-${layerIndex}`;
			const operationType =
				optionalString({
					value: rawLayer.operationType,
					maxCharacters: 80,
				}) ?? "unknown";
			const operationIds = Array.isArray(rawLayer.operationIds)
				? rawLayer.operationIds.filter(
						(operationId): operationId is string =>
							typeof operationId === "string" && operationId.length > 0,
					)
				: [];
			const rawOperationCount = rawLayer.operationCount;
			const operationCount =
				typeof rawOperationCount === "number" &&
				Number.isSafeInteger(rawOperationCount) &&
				rawOperationCount > 0
					? rawOperationCount
					: Math.max(1, operationIds.length);
			const seekTime =
				anchor.kind === "range"
					? anchor.startTime
					: anchor.kind === "point"
						? anchor.time
						: ZERO_MEDIA_TIME;

			items.push({
				key: `${planId}:${layerId}:${planIndex}:${layerIndex}`,
				planId,
				layerId,
				planTitle,
				label:
					optionalString({
						value: rawLayer.label,
						maxCharacters: 200,
					}) ?? defaultLayerLabel(operationType),
				reason: optionalString({
					value: rawLayer.reason,
					maxCharacters: 600,
				}),
				operationType,
				operationCount,
				tombstone:
					typeof rawLayer.tombstone === "boolean"
						? rawLayer.tombstone
						: isInferredTombstone(operationType),
				anchor,
				seekTime,
			});
		}
	}

	return items;
}

export function getAiEditTimelineDuration({
	items,
}: {
	items: readonly AiEditTimelineItem[];
}): MediaTime {
	let duration = ZERO_MEDIA_TIME;
	for (const item of items) {
		const end =
			item.anchor.kind === "range"
				? mediaTime({
						ticks: Math.min(
							Number.MAX_SAFE_INTEGER,
							item.anchor.startTime + item.anchor.duration,
						),
					})
				: item.anchor.kind === "point"
					? item.anchor.time
					: ZERO_MEDIA_TIME;
		if (end > duration) duration = end;
	}
	return duration;
}
