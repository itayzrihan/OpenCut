import type { ParamDefinition } from "@/params";
import { DefinitionRegistry } from "@/params/registry";
import type { TimelineElement } from "@/timeline/types";
import { PARALLAX_CAMERA_KEYFRAME_PARAMS } from "@/parallax-story-teller/camera-keyframes";
import { PARALLAX_CAMERA_GUIDE_KIND } from "@/parallax-story-teller/model";

export interface SpecializedAnimationTarget {
	elementType: TimelineElement["type"];
	paramKind?: string;
	definitionId?: string;
	pathPrefix: "" | "params.";
	params: readonly ParamDefinition[];
}

/** Product definitions consumed by both UI animation resolution and the runtime
 * catalog. Adding a specialized parameter here does not require an agent hook.
 */
export const specializedAnimationTargets = new DefinitionRegistry<
	string,
	SpecializedAnimationTarget
>("specialized animation target");

for (const paramKind of ["parallax-story-teller", PARALLAX_CAMERA_GUIDE_KIND]) {
	specializedAnimationTargets.register({
		key: paramKind,
		definition: {
			elementType: "effect",
			paramKind,
			pathPrefix: "params.",
			params: PARALLAX_CAMERA_KEYFRAME_PARAMS,
		},
	});
}
