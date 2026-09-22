import { effectsRegistry } from "../registry";
import { automaticZoomEffectDefinition } from "./automatic-zoom";
import { blurEffectDefinition } from "./blur";
import { customAiEffectDefinition } from "../custom-ai-effect";
import { editorialEdgeFeatherEffectDefinition } from "./editorial-edge-feather";
import { speakerFrameBreakoutEffectDefinition } from "./speaker-frame-breakout";
import { personCutoutLayerEffectDefinition } from "./person-cutout-layer";

const defaultEffects = [
	automaticZoomEffectDefinition,
	blurEffectDefinition,
	customAiEffectDefinition,
	editorialEdgeFeatherEffectDefinition,
	speakerFrameBreakoutEffectDefinition,
	personCutoutLayerEffectDefinition,
];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (effectsRegistry.has(definition.type)) {
			continue;
		}
		effectsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}
