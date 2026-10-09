import type { EffectDefinition } from "@/effects/types";
export const pushBrollEffectDefinition: EffectDefinition = {
	type: "push-broll",
	name: "Push B-roll",
	keywords: ["broll", "nested", "top", "bottom"],
	params: [
		{
			key: "brollSceneId",
			label: "Content scene",
			type: "text",
			default: "",
			keyframable: false,
		},
		{
			key: "edge",
			label: "Edge",
			type: "text",
			default: "top",
			keyframable: false,
		},
		{
			key: "screenPercent",
			label: "Screen area",
			type: "number",
			default: 40,
			min: 1,
			max: 90,
			step: 1,
			keyframable: false,
		},
		{
			key: "transitionSeconds",
			label: "Entry / exit seconds",
			type: "number",
			default: 0.4,
			min: 0,
			max: 10,
			step: 0.1,
			keyframable: false,
		},
	],
	renderer: { passes: [] },
};
