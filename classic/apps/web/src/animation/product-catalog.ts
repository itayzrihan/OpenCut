import { getParamChannelLayout, type ParamDefinition } from "@/params";
import { elementParamRegistry } from "@/params/registry";
import { effectsRegistry, registerDefaultEffects } from "@/effects";
import { graphicsRegistry } from "@/graphics/registry";
import { registerDefaultGraphics } from "@/graphics/definitions";
import { VISUAL_ELEMENT_TYPES } from "@/timeline/types";
import { specializedAnimationTargets } from "./target-registry";

function describe(param: ParamDefinition) {
	const layout = getParamChannelLayout({ param });
	// Copy data fields explicitly: custom UI read/write and layout callbacks
	// remain host functions, and are never tool payloads or model instructions.
	return {
		key: param.key,
		label: param.label,
		type: param.type,
		default: param.default,
		keyframable: param.keyframable,
		dependencies: param.dependencies,
		group: param.group,
		...(param.type === "number" && {
			min: param.min,
			max: param.max,
			step: param.step,
			displayMultiplier: param.displayMultiplier,
		}),
		...(param.type === "select" && { options: param.options }),
		channelLayout:
			layout.kind === "leaf"
				? {
						kind: layout.kind,
						codec: layout.codec,
						easingMode: layout.easingMode,
						component: layout.component,
					}
				: {
						kind: layout.kind,
						codec: layout.codec,
						easingMode: layout.easingMode,
						components: layout.components,
					},
	};
}

/** Bind the same registries used by resolveAnimationTarget to one runtime.
 * New definitions are published automatically; disposal detaches this session.
 */
export function bindProductAnimationCatalog(
	publish: (groups: unknown) => void,
): () => void {
	registerDefaultEffects();
	registerDefaultGraphics();
	let elements = elementParamRegistry.entries();
	let graphics = graphicsRegistry.entries();
	let effects = effectsRegistry.catalog();
	let specialized = specializedAnimationTargets.entries();
	const emit = () =>
		publish([
			...specialized.map(([, { params, ...target }]) => ({
				target: { kind: "element", ...target },
				params: params.map(describe),
			})),
			...elements.map(([elementType, params]) => ({
				target: { kind: "element", elementType, pathPrefix: "" },
				params: params.map(describe),
			})),
			...graphics.map(([definitionId, definition]) => ({
				target: {
					kind: "element",
					elementType: "graphic",
					definitionId,
					pathPrefix: "params.",
				},
				params: definition.params.map(describe),
			})),
			...effects.map((definition) => ({
				target: {
					kind: "effect",
					effectType: definition.type,
					elementTypes: VISUAL_ELEMENT_TYPES,
				},
				params: definition.params.map(describe),
			})),
		]);
	emit();
	const unsubscribe = [
		specializedAnimationTargets.subscribeDefinitions((next) => {
			specialized = next;
			emit();
		}),
		elementParamRegistry.subscribeDefinitions((next) => {
			elements = next;
			emit();
		}),
		graphicsRegistry.subscribeDefinitions((next) => {
			graphics = next;
			emit();
		}),
		effectsRegistry.subscribe((next) => {
			effects = next;
			emit();
		}),
	];
	return () => {
		for (const dispose of unsubscribe) dispose();
	};
}
