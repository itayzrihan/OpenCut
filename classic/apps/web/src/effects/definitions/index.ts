import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { customAiEffectDefinition } from "../custom-ai-effect";
import { editorialEdgeFeatherEffectDefinition } from "./editorial-edge-feather";
import { speakerFrameBreakoutEffectDefinition } from "./speaker-frame-breakout";

const defaultEffects = [
	blurEffectDefinition,
	customAiEffectDefinition,
	editorialEdgeFeatherEffectDefinition,
	speakerFrameBreakoutEffectDefinition,
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
