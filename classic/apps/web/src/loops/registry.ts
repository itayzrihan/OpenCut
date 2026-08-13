import type { LoopPreset, LoopRecipe } from "./types";

const keys = (...points: Array<[number, number]>) =>
	points.map(([at, value]) => ({ at, value }));

function loop({
	id,
	label,
	cycleSeconds,
	recipe,
	keywords = [],
	accumulate = [],
}: {
	id: string;
	label: string;
	cycleSeconds: number;
	recipe: LoopRecipe;
	keywords?: string[];
	accumulate?: LoopPreset["accumulate"];
}): LoopPreset {
	return { id, label, cycleSeconds, recipe, keywords, accumulate };
}

export const LOOP_PRESETS: LoopPreset[] = [
	loop({
		id: "none",
		label: "Clear Loop",
		cycleSeconds: 1,
		recipe: {},
		keywords: ["clear", "remove"],
	}),
	loop({
		id: "vibration",
		label: "Vibration",
		cycleSeconds: 0.42,
		recipe: {
			"transform.positionX": keys(
				[0, -8],
				[0.18, 7],
				[0.38, -5],
				[0.62, 5],
				[0.82, -3],
				[1, 0],
			),
			"transform.positionY": keys([0, 3], [0.3, -3], [0.62, 2], [1, 0]),
			"transform.rotate": keys([0, -1.4], [0.28, 1.4], [0.62, -0.9], [1, 0]),
		},
		keywords: ["shake", "impact", "jitter"],
	}),
	loop({
		id: "shake-subtle",
		label: "Shake Subtle",
		cycleSeconds: 0.8,
		recipe: {
			"transform.positionX": keys(
				[0, -4],
				[0.25, 4],
				[0.5, -3],
				[0.75, 3],
				[1, 0],
			),
			"transform.positionY": keys([0, -2], [0.5, 2], [1, 0]),
		},
		keywords: ["shake", "handheld"],
	}),
	loop({
		id: "side-to-side",
		label: "Side to Side",
		cycleSeconds: 2.4,
		recipe: {
			"transform.positionX": keys([0, -42], [0.5, 42], [1, -42]),
		},
		keywords: ["horizontal", "sway", "left", "right"],
	}),
	loop({
		id: "up-and-down",
		label: "Up and Down",
		cycleSeconds: 2.2,
		recipe: {
			"transform.positionY": keys([0, -26], [0.5, 26], [1, -26]),
		},
		keywords: ["vertical", "bob", "float"],
	}),
	loop({
		id: "rotation-sway",
		label: "Rotation Sway",
		cycleSeconds: 2.6,
		recipe: {
			"transform.rotate": keys([0, -7], [0.5, 7], [1, -7]),
		},
		keywords: ["tilt", "rock", "pendulum"],
	}),
	loop({
		id: "spin",
		label: "Spin",
		cycleSeconds: 2.2,
		recipe: {
			"transform.rotate": keys([0, 0], [0.5, 180], [1, 360]),
		},
		accumulate: ["transform.rotate"],
		keywords: ["rotate", "clockwise"],
	}),
	loop({
		id: "spin-counter-clockwise",
		label: "Spin Counter",
		cycleSeconds: 2.2,
		recipe: {
			"transform.rotate": keys([0, 0], [0.5, -180], [1, -360]),
		},
		accumulate: ["transform.rotate"],
		keywords: ["rotate", "counter", "reverse"],
	}),
	loop({
		id: "orbit",
		label: "Orbit",
		cycleSeconds: 3.2,
		recipe: {
			"transform.positionX": keys([0, -28], [0.25, 28], [0.75, 28], [1, -28]),
			"transform.positionY": keys([0, 18], [0.25, -18], [0.75, -18], [1, 18]),
			"transform.rotate": keys([0, -4], [0.5, 4], [1, -4]),
		},
		keywords: ["circle", "sweep", "round"],
	}),
	loop({
		id: "flicker",
		label: "Flicker",
		cycleSeconds: 0.9,
		recipe: {
			opacity: keys(
				[0, 1],
				[0.12, 0.42],
				[0.22, 1],
				[0.4, 0.62],
				[0.52, 1],
				[0.7, 0.76],
				[1, 1],
			),
		},
		keywords: ["blink", "light", "glitch"],
	}),
	loop({
		id: "fade-30",
		label: "In / Out 30% Fade",
		cycleSeconds: 2.2,
		recipe: { opacity: keys([0, 1], [0.5, 0.7], [1, 1]) },
		keywords: ["opacity", "fade", "thirty"],
	}),
	loop({
		id: "breath-expand",
		label: "Breath Expand",
		cycleSeconds: 3.4,
		recipe: {
			"transform.scaleX": keys([0, 1], [0.5, 1.08], [1, 1]),
			"transform.scaleY": keys([0, 1], [0.5, 1.08], [1, 1]),
		},
		keywords: ["breathe", "expand", "slow", "pulse"],
	}),
	loop({
		id: "pulse",
		label: "Pulse",
		cycleSeconds: 1.5,
		recipe: {
			"transform.scaleX": keys(
				[0, 1],
				[0.2, 1.14],
				[0.45, 1],
				[0.7, 1.08],
				[1, 1],
			),
			"transform.scaleY": keys(
				[0, 1],
				[0.2, 1.14],
				[0.45, 1],
				[0.7, 1.08],
				[1, 1],
			),
		},
		keywords: ["heartbeat", "beat", "scale"],
	}),
	loop({
		id: "heartbeat",
		label: "Heartbeat",
		cycleSeconds: 1.1,
		recipe: {
			"transform.scaleX": keys(
				[0, 1],
				[0.16, 1.18],
				[0.31, 1],
				[0.46, 1.12],
				[0.64, 1],
				[1, 1],
			),
			"transform.scaleY": keys(
				[0, 1],
				[0.16, 1.18],
				[0.31, 1],
				[0.46, 1.12],
				[0.64, 1],
				[1, 1],
			),
		},
		keywords: ["pulse", "double", "beat"],
	}),
	loop({
		id: "float",
		label: "Float",
		cycleSeconds: 3.8,
		recipe: {
			"transform.positionY": keys([0, 18], [0.5, -18], [1, 18]),
			"transform.scaleX": keys([0, 1], [0.5, 1.025], [1, 1]),
			"transform.scaleY": keys([0, 1], [0.5, 1.025], [1, 1]),
		},
		keywords: ["soft", "air", "lift"],
	}),
	loop({
		id: "sway",
		label: "Sway",
		cycleSeconds: 2.8,
		recipe: {
			"transform.positionX": keys([0, -22], [0.5, 22], [1, -22]),
			"transform.rotate": keys([0, -3], [0.5, 3], [1, -3]),
		},
		keywords: ["swing", "rock", "gentle"],
	}),
	loop({
		id: "zoom-breathe",
		label: "Zoom Breathe",
		cycleSeconds: 4.2,
		recipe: {
			"transform.scaleX": keys([0, 0.98], [0.5, 1.06], [1, 0.98]),
			"transform.scaleY": keys([0, 0.98], [0.5, 1.06], [1, 0.98]),
		},
		keywords: ["zoom", "cinematic", "breath"],
	}),
	loop({
		id: "tilt-wave",
		label: "Tilt Wave",
		cycleSeconds: 1.8,
		recipe: {
			"transform.rotate": keys(
				[0, -10],
				[0.25, 6],
				[0.5, -3],
				[0.75, 8],
				[1, -10],
			),
		},
		keywords: ["wave", "wiggle", "rotate"],
	}),
	loop({
		id: "soft-drift",
		label: "Soft Drift",
		cycleSeconds: 5.4,
		recipe: {
			"transform.positionX": keys([0, -16], [0.5, 16], [1, -16]),
			"transform.positionY": keys([0, 10], [0.5, -10], [1, 10]),
		},
		keywords: ["slow", "ambient", "drift"],
	}),
	loop({
		id: "focus-pulse",
		label: "Focus Pulse",
		cycleSeconds: 2.6,
		recipe: {
			opacity: keys([0, 0.88], [0.5, 1], [1, 0.88]),
			"transform.scaleX": keys([0, 1], [0.5, 1.045], [1, 1]),
			"transform.scaleY": keys([0, 1], [0.5, 1.045], [1, 1]),
		},
		keywords: ["focus", "glow", "subtle"],
	}),
];

export function getLoopPreset({ id }: { id: string }): LoopPreset {
	return LOOP_PRESETS.find((preset) => preset.id === id) ?? LOOP_PRESETS[0];
}
