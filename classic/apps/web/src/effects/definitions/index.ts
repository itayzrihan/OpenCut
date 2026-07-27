import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { customAiEffectDefinition } from "../custom-ai-effect";

const defaultEffects = [blurEffectDefinition, customAiEffectDefinition];

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
