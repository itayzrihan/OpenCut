import type { AiEditOperation } from "./types";

const BROAD_CREATIVE_INTENT_PATTERN =
	/\b(epic|amazing|cinematic|dynamic|dramatic|high[ -]?energy|hype|trailer|premium|professional|polish(?:ed)?|make (?:it|this) pop|vfx|visual effects?|sfx|sound effects?|sound design)\b/iu;
const SFX_INTENT_PATTERN =
	/\b(sfx|sound effects?|sound design|audio accents?|sonic|whooshes?|impacts?|risers?)\b/iu;
const VFX_INTENT_PATTERN =
	/\b(vfx|visual effects?|effects? pass|glitch|light leaks?|particles?|screen shake|flash(?:es)?)\b/iu;

const AUDIO_OPERATION_TYPES = new Set<AiEditOperation["type"]>([
	"insert_library_audio_element",
]);
const VFX_OPERATION_TYPES = new Set<AiEditOperation["type"]>([
	"add_clip_effect",
	"update_clip_effect_params",
	"set_clip_effect_enabled",
	"reorder_clip_effect",
	"set_background_removal",
	"attach_custom_edit",
	"insert_effect_element",
]);
const DESIGN_OPERATION_TYPES = new Set<AiEditOperation["type"]>([
	"insert_text_element",
	"insert_graphic_element",
	"insert_html_element",
	"insert_sticker_element",
	"set_project_settings",
]);
const MOTION_OPERATION_TYPES = new Set<AiEditOperation["type"]>([
	"apply_transition",
	"upsert_keyframe",
	"remove_keyframe",
	"move_element",
]);
const PACING_OPERATION_TYPES = new Set<AiEditOperation["type"]>([
	"trim_element",
	"split_element",
	"delete_element",
	"duplicate_element",
	"retime_element",
	"move_element",
	"apply_transition",
]);

export interface CreativePlanQualityInput {
	title?: string;
	summary?: string;
	operations: AiEditOperation[];
}

/**
 * Adds review guidance for obviously under-resolved or mechanically repetitive
 * creative plans. These are warnings rather than hard failures because a short
 * range can legitimately need one restrained operation.
 */
export function getCreativePlanQualityNotes({
	title = "",
	summary = "",
	operations,
}: CreativePlanQualityInput): string[] {
	const notes: string[] = [];
	const brief = `${title} ${summary}`.trim();
	const hasBroadCreativeIntent = BROAD_CREATIVE_INTENT_PATTERN.test(brief);
	const requestsSfx = SFX_INTENT_PATTERN.test(brief);
	const requestsVfx = VFX_INTENT_PATTERN.test(brief);

	if (hasBroadCreativeIntent && operations.length <= 1) {
		notes.push(
			"Creative quality warning: this broad creative treatment is unusually minimal. Verify that it resolves the selected content's main beats through deliberate pacing, framing or motion, visual treatment, and requested sound design rather than a generic single change.",
		);
	}

	if (
		requestsSfx &&
		!operations.some((operation) => AUDIO_OPERATION_TYPES.has(operation.type))
	) {
		notes.push(
			"Creative quality warning: the reviewed brief calls for SFX or sound design, but the plan contains no shared-library audio insertion. Search for exact resolvable audio assets or state why none fits; never fabricate an asset id.",
		);
	}

	if (
		requestsVfx &&
		!operations.some((operation) => VFX_OPERATION_TYPES.has(operation.type))
	) {
		notes.push(
			"Creative quality warning: the reviewed brief calls for VFX, but the plan contains no supported effect operation. Choose content-specific effects from live app capabilities or state the concrete limitation; do not substitute repetitive zooms or transitions.",
		);
	}

	const creativeDimensions = getCreativeDimensions({ operations });
	if (
		hasBroadCreativeIntent &&
		operations.length >= 4 &&
		creativeDimensions.size <= 1
	) {
		notes.push(
			"Creative quality warning: this broad treatment is single-dimensional. Check the observed beats for a restrained combination of pacing, motion, design/VFX, typography, and sound; add only dimensions justified by the content.",
		);
	}

	if (operations.length >= 8) {
		const typeCounts = new Map<AiEditOperation["type"], number>();
		for (const operation of operations) {
			typeCounts.set(operation.type, (typeCounts.get(operation.type) ?? 0) + 1);
		}
		const dominantCount = Math.max(...typeCounts.values());
		if (dominantCount / operations.length >= 0.75) {
			notes.push(
				"Creative quality warning: one operation type dominates this plan. Confirm that the repetition follows distinct content beats and that a smaller, more varied treatment would not communicate the intent better.",
			);
		}
	}

	appendTransitionRepetitionNote({ operations, notes });
	appendScaleKeyframeDominanceNote({ operations, notes });
	return notes;
}

function getCreativeDimensions({
	operations,
}: {
	operations: AiEditOperation[];
}): Set<string> {
	const dimensions = new Set<string>();
	for (const operation of operations) {
		if (AUDIO_OPERATION_TYPES.has(operation.type)) dimensions.add("sound");
		if (VFX_OPERATION_TYPES.has(operation.type)) dimensions.add("vfx");
		if (DESIGN_OPERATION_TYPES.has(operation.type)) dimensions.add("design");
		if (MOTION_OPERATION_TYPES.has(operation.type)) dimensions.add("motion");
		if (PACING_OPERATION_TYPES.has(operation.type)) dimensions.add("pacing");
	}
	return dimensions;
}

function appendTransitionRepetitionNote({
	operations,
	notes,
}: {
	operations: AiEditOperation[];
	notes: string[];
}): void {
	const transitions = operations.filter(
		(
			operation,
		): operation is Extract<AiEditOperation, { type: "apply_transition" }> =>
			operation.type === "apply_transition",
	);
	if (transitions.length < 8) return;

	const signatures = new Map<string, number>();
	for (const operation of transitions) {
		const signature = `${operation.presetId}:${operation.side}`;
		signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
	}
	const mostRepeated = Math.max(...signatures.values());
	if (mostRepeated / transitions.length >= 0.5) {
		notes.push(
			"Creative quality warning: most transition operations repeat the same preset and side. Review whether each repetition serves a distinct content beat.",
		);
	}
}

function appendScaleKeyframeDominanceNote({
	operations,
	notes,
}: {
	operations: AiEditOperation[];
	notes: string[];
}): void {
	const scaleKeyframes = operations.filter(
		(
			operation,
		): operation is Extract<AiEditOperation, { type: "upsert_keyframe" }> =>
			operation.type === "upsert_keyframe" &&
			(operation.propertyPath === "transform.scaleX" ||
				operation.propertyPath === "transform.scaleY"),
	);
	if (scaleKeyframes.length < 12) return;

	const targetCount = new Set(
		scaleKeyframes.map(
			(operation) => `${operation.trackId}:${operation.elementId}`,
		),
	).size;
	if (targetCount <= 2 && scaleKeyframes.length / operations.length >= 0.45) {
		notes.push(
			"Creative quality warning: the plan is dominated by repeated scale keyframes on very few elements. Check framing, pacing, color, graphics, overlays, and other requested dimensions before applying.",
		);
	}
}
