import type { ParamValues } from "@/params";

export interface EditorialTextStyle {
	id: string;
	name: string;
	description: string;
	sample: string;
	params: Partial<ParamValues>;
}

export const EDITORIAL_TEXT_STYLES: EditorialTextStyle[] = [
	{
		id: "editorial-feather-white",
		name: "Feathered White",
		description:
			"White editorial type with a wide, nearly invisible lower shadow for footage.",
		sample: "Make it clear",
		params: {
			color: "#ffffff",
			fontWeight: "bold",
			lineHeight: 1.05,
			"stroke.enabled": false,
			"shadow.enabled": true,
			"shadow.color": "#00000052",
			"shadow.blur": 18,
			"shadow.offsetX": 0,
			"shadow.offsetY": 5,
		},
	},
	{
		id: "editorial-feather-black",
		name: "Feathered Black",
		description:
			"Near-black editorial type with a restrained lower feather for light proof stages.",
		sample: "Show the proof",
		params: {
			color: "#111111",
			fontWeight: "bold",
			lineHeight: 1.05,
			"stroke.enabled": false,
			"shadow.enabled": true,
			"shadow.color": "#00000024",
			"shadow.blur": 14,
			"shadow.offsetX": 0,
			"shadow.offsetY": 4,
		},
	},
];

export function findEditorialTextStyle({
	id,
}: {
	id: string;
}): EditorialTextStyle | null {
	return EDITORIAL_TEXT_STYLES.find((style) => style.id === id) ?? null;
}
