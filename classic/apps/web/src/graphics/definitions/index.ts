import { graphicsRegistry } from "../registry";
import { ellipseGraphicDefinition } from "./ellipse";
import { hyperframeGraphicDefinition } from "./hyperframe";
import { polygonGraphicDefinition } from "./polygon";
import { presetBackgroundGraphicDefinition } from "./preset-background";
import { rectangleGraphicDefinition } from "./rectangle";
import { starGraphicDefinition } from "./star";
import { uiElementGraphicDefinition } from "./ui-element";

const defaultGraphicDefinitions = [
	rectangleGraphicDefinition,
	ellipseGraphicDefinition,
	polygonGraphicDefinition,
	starGraphicDefinition,
	presetBackgroundGraphicDefinition,
	hyperframeGraphicDefinition,
	uiElementGraphicDefinition,
];

export function registerDefaultGraphics(): void {
	for (const definition of defaultGraphicDefinitions) {
		if (graphicsRegistry.has(definition.id)) {
			continue;
		}
		graphicsRegistry.register({
			key: definition.id,
			definition,
		});
	}
}

export {
	ellipseGraphicDefinition,
	hyperframeGraphicDefinition,
	polygonGraphicDefinition,
	presetBackgroundGraphicDefinition,
	rectangleGraphicDefinition,
	starGraphicDefinition,
	uiElementGraphicDefinition,
};
export { STROKE_ALIGN_PARAM } from "./shared";
export { UI_ELEMENT_GRAPHIC_ID } from "./ui-element";
