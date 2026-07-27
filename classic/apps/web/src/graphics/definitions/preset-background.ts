import type { ParamDefinition } from "@/params";
import { BACKGROUND_PRESETS } from "@/backgrounds/presets";
import type { GraphicDefinition } from "../types";

type BackgroundParams = {
	preset: string;
	presetId: string;
	colorA: string;
	colorB: string;
	colorC: string;
	density: number;
	intensity: number;
	scale: number;
	seed: number;
};

const BACKGROUND_STYLE_OPTIONS = BACKGROUND_PRESETS.reduce<
	Array<{ value: string; label: string }>
>((options, preset) => {
	const value = String(preset.params.preset ?? preset.id);
	if (!options.some((option) => option.value === value)) {
		options.push({ value, label: preset.name });
	}
	return options;
}, []);

const BACKGROUND_PARAMS: ParamDefinition<keyof BackgroundParams & string>[] = [
	{
		key: "preset",
		label: "Style",
		type: "select",
		default: "clean",
		options: BACKGROUND_STYLE_OPTIONS,
	},
	{ key: "presetId", label: "Preset ID", type: "text", default: "clean" },
	{ key: "colorA", label: "Base", type: "color", default: "#10131f" },
	{ key: "colorB", label: "Accent", type: "color", default: "#f4f1e8" },
	{ key: "colorC", label: "Highlight", type: "color", default: "#ffffff" },
	{
		key: "density",
		label: "Density",
		type: "number",
		default: 48,
		min: 1,
		max: 100,
		step: 1,
	},
	{
		key: "intensity",
		label: "Intensity",
		type: "number",
		default: 55,
		min: 0,
		max: 100,
		step: 1,
	},
	{
		key: "scale",
		label: "Scale",
		type: "number",
		default: 52,
		min: 1,
		max: 100,
		step: 1,
	},
	{
		key: "seed",
		label: "Seed",
		type: "number",
		default: 3,
		min: 1,
		max: 99,
		step: 1,
	},
];

export const presetBackgroundGraphicDefinition: GraphicDefinition = {
	id: "preset-background",
	name: "Preset Background",
	keywords: ["background", "pattern", "grid", "film", "texture"],
	params: BACKGROUND_PARAMS,
	render({ ctx, params, width, height, localTime = 0 }) {
		const style = String(params.preset ?? "clean");
		const colorA = String(params.colorA ?? "#10131f");
		const colorB = String(params.colorB ?? "#f4f1e8");
		const colorC = String(params.colorC ?? "#ffffff");
		const density = clamp(Number(params.density ?? 48), 1, 100);
		const intensity = clamp(Number(params.intensity ?? 55), 0, 100) / 100;
		const scale = clamp(Number(params.scale ?? 52), 1, 100);
		const seed = Math.max(1, Math.round(Number(params.seed ?? 3)));
		const animatedSeed = seed + Math.floor(localTime * 12);

		ctx.clearRect(0, 0, width, height);
		fillGradient({ ctx, width, height, colorA, colorB, intensity });

		switch (style) {
			case "grid":
				drawGrid({ ctx, width, height, color: colorB, density, intensity });
				break;
			case "grid-waves":
				drawGrid({
					ctx,
					width,
					height,
					color: colorB,
					density,
					intensity: intensity * 0.7,
				});
				drawWaves({
					ctx,
					width,
					height,
					color: colorC,
					density,
					intensity,
					scale,
					phase: localTime,
				});
				break;
			case "waves":
				drawWaves({
					ctx,
					width,
					height,
					color: colorB,
					density,
					intensity,
					scale,
					phase: localTime,
				});
				break;
			case "snow-screen":
				drawNoise({
					ctx,
					width,
					height,
					color: colorB,
					density,
					intensity,
					seed: animatedSeed,
				});
				drawScanlines({
					ctx,
					width,
					height,
					color: colorB,
					density: 84,
					intensity: intensity * 0.35,
				});
				break;
			case "retro-film":
				drawFilmTexture({
					ctx,
					width,
					height,
					color: colorC,
					density,
					intensity,
					seed: animatedSeed,
				});
				break;
			case "newspaper":
				drawPaper({
					ctx,
					width,
					height,
					color: colorB,
					density,
					intensity,
					seed,
				});
				drawCrumples({ ctx, width, height, color: colorB, density, intensity });
				break;
			case "paper":
				drawPaper({
					ctx,
					width,
					height,
					color: colorB,
					density,
					intensity,
					seed,
				});
				break;
			case "topographic":
				drawTopographic({
					ctx,
					width,
					height,
					color: colorB,
					density,
					intensity,
				});
				break;
			case "halftone":
				drawHalftone({ ctx, width, height, color: colorB, density, intensity });
				break;
			case "aurora":
				drawAurora({ ctx, width, height, colorB, colorC, density, intensity });
				break;
			case "bokeh":
				drawBokeh({
					ctx,
					width,
					height,
					colorB,
					colorC,
					density,
					intensity,
					seed: animatedSeed,
				});
				break;
			case "stars":
			case "snowfall":
				drawParticles({
					ctx,
					width,
					height,
					color: colorB,
					density,
					intensity,
					seed: style === "snowfall" ? animatedSeed : seed,
					soft: style === "snowfall",
				});
				break;
			case "pixel-rain":
				drawPixelRain({
					ctx,
					width,
					height,
					color: colorB,
					density,
					intensity,
					seed: animatedSeed,
					phase: localTime,
				});
				break;
			case "scanlines":
				drawScanlines({
					ctx,
					width,
					height,
					color: colorB,
					density,
					intensity,
				});
				break;
			case "vhs-bars":
				drawVhsBars({ ctx, width, height, colorB, colorC, density, intensity });
				break;
			case "film-burn":
				drawFilmBurn({
					ctx,
					width,
					height,
					colorB,
					colorC,
					density,
					intensity,
				});
				break;
			case "dust":
				drawParticles({
					ctx,
					width,
					height,
					color: colorB,
					density,
					intensity,
					seed,
					soft: false,
				});
				break;
			case "scratches":
				drawScratches({
					ctx,
					width,
					height,
					color: colorB,
					density,
					intensity,
					seed,
				});
				break;
			case "rain":
				drawRain({ ctx, width, height, color: colorB, density, intensity });
				break;
			case "embers":
				drawParticles({
					ctx,
					width,
					height,
					color: colorB,
					density,
					intensity,
					seed,
					soft: true,
				});
				drawParticles({
					ctx,
					width,
					height,
					color: colorC,
					density: density * 0.5,
					intensity,
					seed: animatedSeed + 8,
					soft: true,
				});
				break;
			case "smoke":
				drawSmoke({ ctx, width, height, color: colorB, density, intensity });
				break;
			case "marble":
				drawMarble({ ctx, width, height, color: colorB, density, intensity });
				break;
			case "circuit":
				drawCircuit({
					ctx,
					width,
					height,
					color: colorB,
					density,
					intensity,
					seed,
				});
				break;
			case "stripes":
				drawStripes({ ctx, width, height, color: colorB, density, intensity });
				break;
			case "checker":
				drawChecker({ ctx, width, height, color: colorB, density, intensity });
				break;
			default:
				drawPaper({
					ctx,
					width,
					height,
					color: colorB,
					density: 24,
					intensity: intensity * 0.3,
					seed,
				});
		}
	},
};

function fillGradient({
	ctx,
	width,
	height,
	colorA,
	colorB,
	intensity,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	colorA: string;
	colorB: string;
	intensity: number;
}) {
	const baseGradientAlpha = 0.35 + intensity * 0.65;

	ctx.fillStyle = withAlpha(colorA, 1);
	ctx.fillRect(0, 0, width, height);

	const gradient = ctx.createLinearGradient(0, 0, width, height);
	gradient.addColorStop(0, withAlpha(colorA, 1));
	gradient.addColorStop(1, withAlpha(colorB, baseGradientAlpha));
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, width, height);
}

function drawGrid({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
}: DrawParams) {
	const step = Math.max(8, 90 - density);
	ctx.strokeStyle = withAlpha(color, 0.12 + intensity * 0.35);
	ctx.lineWidth = 1;
	ctx.beginPath();
	for (let x = 0; x <= width; x += step) {
		ctx.moveTo(x, 0);
		ctx.lineTo(x, height);
	}
	for (let y = 0; y <= height; y += step) {
		ctx.moveTo(0, y);
		ctx.lineTo(width, y);
	}
	ctx.stroke();
}

function drawWaves({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
	scale,
	phase = 0,
}: DrawParams & { scale: number; phase?: number }) {
	ctx.strokeStyle = withAlpha(color, 0.2 + intensity * 0.45);
	ctx.lineWidth = 1.5;
	const count = Math.max(4, Math.round(density / 8));
	for (let i = 0; i < count; i++) {
		const y = (height / count) * i;
		ctx.beginPath();
		for (let x = 0; x <= width; x += 8) {
			const waveY =
				y +
				Math.sin((x + i * 48 + phase * 96) / (18 + scale)) *
					(10 + intensity * 28);
			if (x === 0) ctx.moveTo(x, waveY);
			else ctx.lineTo(x, waveY);
		}
		ctx.stroke();
	}
}

function drawNoise({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
	seed,
}: DrawParams & { seed: number }) {
	const count = Math.round((density * width * height) / 900);
	ctx.fillStyle = withAlpha(color, 0.2 + intensity * 0.6);
	for (let i = 0; i < count; i++) {
		const x = random(seed, i) * width;
		const y = random(seed + 13, i) * height;
		const size = 1 + random(seed + 27, i) * 2;
		ctx.fillRect(x, y, size, size);
	}
}

function drawFilmTexture(params: DrawParams & { seed: number }) {
	drawNoise(params);
	drawScratches(params);
}

function drawPaper(params: DrawParams & { seed: number }) {
	drawNoise({ ...params, intensity: params.intensity * 0.35 });
}

function drawCrumples({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
}: DrawParams) {
	ctx.strokeStyle = withAlpha(color, 0.08 + intensity * 0.18);
	ctx.lineWidth = 2;
	for (let i = 0; i < density / 3; i++) {
		ctx.beginPath();
		ctx.moveTo((width / density) * i * 3, 0);
		ctx.lineTo(width * Math.sin(i), height);
		ctx.stroke();
	}
}

function drawTopographic({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
}: DrawParams) {
	ctx.strokeStyle = withAlpha(color, 0.18 + intensity * 0.35);
	ctx.lineWidth = 1.2;
	for (let r = 20; r < width; r += Math.max(14, 80 - density)) {
		ctx.beginPath();
		ctx.ellipse(width * 0.5, height * 0.5, r, r * 0.55, r / 90, 0, Math.PI * 2);
		ctx.stroke();
	}
}

function drawHalftone({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
}: DrawParams) {
	const step = Math.max(8, 74 - density);
	ctx.fillStyle = withAlpha(color, 0.2 + intensity * 0.5);
	for (let y = 0; y < height; y += step) {
		for (let x = 0; x < width; x += step) {
			ctx.beginPath();
			ctx.arc(x, y, step * (0.12 + intensity * 0.18), 0, Math.PI * 2);
			ctx.fill();
		}
	}
}

function drawAurora({
	ctx,
	width,
	height,
	colorB,
	colorC,
	intensity,
}: ColorPairParams) {
	for (let i = 0; i < 5; i++) {
		ctx.fillStyle = withAlpha(i % 2 ? colorB : colorC, 0.08 + intensity * 0.12);
		ctx.beginPath();
		ctx.ellipse(
			width * (0.2 + i * 0.15),
			height * 0.45,
			width * 0.26,
			height * 0.08,
			i * 0.5,
			0,
			Math.PI * 2,
		);
		ctx.fill();
	}
}

function drawBokeh({
	ctx,
	width,
	height,
	colorB,
	colorC,
	density,
	intensity,
	seed,
}: ColorPairParams & { seed: number }) {
	for (let i = 0; i < density; i++) {
		ctx.fillStyle = withAlpha(i % 2 ? colorB : colorC, 0.08 + intensity * 0.2);
		ctx.beginPath();
		ctx.arc(
			random(seed, i) * width,
			random(seed + 9, i) * height,
			6 + random(seed + 4, i) * 22,
			0,
			Math.PI * 2,
		);
		ctx.fill();
	}
}

function drawParticles({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
	seed,
	soft,
}: DrawParams & { seed: number; soft: boolean }) {
	ctx.fillStyle = withAlpha(color, 0.18 + intensity * 0.5);
	for (let i = 0; i < density * 2; i++) {
		ctx.beginPath();
		ctx.arc(
			random(seed, i) * width,
			random(seed + 9, i) * height,
			soft ? 1 + random(seed + 4, i) * 4 : 1,
			0,
			Math.PI * 2,
		);
		ctx.fill();
	}
}

function drawPixelRain({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
	seed,
	phase = 0,
}: DrawParams & { seed: number; phase?: number }) {
	ctx.fillStyle = withAlpha(color, 0.14 + intensity * 0.45);
	for (let i = 0; i < density; i++) {
		const x = random(seed, i) * width;
		const y = (random(seed + 2, i) * height + phase * 80) % height;
		ctx.fillRect(x, y, 2 + intensity * 6, 20 + random(seed + 5, i) * 80);
	}
}

function drawScanlines({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
}: DrawParams) {
	ctx.fillStyle = withAlpha(color, 0.08 + intensity * 0.22);
	const step = Math.max(3, 20 - density / 6);
	for (let y = 0; y < height; y += step) ctx.fillRect(0, y, width, 1);
}

function drawVhsBars({
	ctx,
	width,
	height,
	colorB,
	colorC,
	intensity,
}: ColorPairParams) {
	const colors = [
		"#ef4444",
		"#f59e0b",
		"#eab308",
		"#22c55e",
		colorB,
		colorC,
		"#a855f7",
	];
	colors.forEach((color, index) => {
		ctx.fillStyle = withAlpha(color, 0.18 + intensity * 0.45);
		ctx.fillRect(
			(width / colors.length) * index,
			0,
			width / colors.length,
			height,
		);
	});
}

function drawFilmBurn({
	ctx,
	width,
	height,
	colorB,
	colorC,
	intensity,
}: ColorPairParams) {
	const gradient = ctx.createRadialGradient(0, height, 0, 0, height, width);
	gradient.addColorStop(0, withAlpha(colorC, 0.35 + intensity * 0.45));
	gradient.addColorStop(0.45, withAlpha(colorB, 0.15 + intensity * 0.25));
	gradient.addColorStop(1, "rgba(0,0,0,0)");
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, width, height);
}

function drawScratches({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
	seed,
}: DrawParams & { seed: number }) {
	ctx.strokeStyle = withAlpha(color, 0.16 + intensity * 0.42);
	ctx.lineWidth = 1;
	for (let i = 0; i < density / 2; i++) {
		const x = random(seed, i) * width;
		ctx.beginPath();
		ctx.moveTo(x, random(seed + 2, i) * height);
		ctx.lineTo(x + random(seed + 3, i) * 12 - 6, height);
		ctx.stroke();
	}
}

function drawRain({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
}: DrawParams) {
	ctx.strokeStyle = withAlpha(color, 0.14 + intensity * 0.36);
	ctx.lineWidth = 1.5;
	for (let i = 0; i < density * 2; i++) {
		const x = (width / (density * 2)) * i;
		ctx.beginPath();
		ctx.moveTo(x, 0);
		ctx.lineTo(x - 50, height);
		ctx.stroke();
	}
}

function drawSmoke({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
}: DrawParams) {
	ctx.fillStyle = withAlpha(color, 0.05 + intensity * 0.16);
	for (let i = 0; i < density / 2; i++) {
		ctx.beginPath();
		ctx.ellipse(
			width * 0.5,
			height * (i / density) * 2,
			width * 0.5,
			height * 0.08,
			i,
			0,
			Math.PI * 2,
		);
		ctx.fill();
	}
}

function drawMarble({ ctx, width, color, density, intensity }: DrawParams) {
	ctx.strokeStyle = withAlpha(color, 0.14 + intensity * 0.3);
	for (let i = 0; i < density; i++) {
		ctx.beginPath();
		ctx.moveTo(0, i * 11);
		ctx.bezierCurveTo(width * 0.3, i * 8, width * 0.55, i * 14, width, i * 9);
		ctx.stroke();
	}
}

function drawCircuit({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
	seed,
}: DrawParams & { seed: number }) {
	ctx.strokeStyle = withAlpha(color, 0.16 + intensity * 0.38);
	ctx.lineWidth = 1.5;
	for (let i = 0; i < density; i++) {
		const x = random(seed, i) * width;
		const y = random(seed + 1, i) * height;
		ctx.beginPath();
		ctx.moveTo(x, y);
		ctx.lineTo(x + 40, y);
		ctx.lineTo(x + 40, y + 30);
		ctx.stroke();
	}
}

function drawStripes({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
}: DrawParams) {
	ctx.fillStyle = withAlpha(color, 0.12 + intensity * 0.35);
	const step = Math.max(12, 90 - density);
	for (let x = -height; x < width; x += step) {
		ctx.save();
		ctx.translate(x, 0);
		ctx.rotate(-Math.PI / 6);
		ctx.fillRect(0, 0, step * 0.45, height * 2);
		ctx.restore();
	}
}

function drawChecker({
	ctx,
	width,
	height,
	color,
	density,
	intensity,
}: DrawParams) {
	ctx.fillStyle = withAlpha(color, 0.12 + intensity * 0.38);
	const step = Math.max(12, 90 - density);
	for (let y = 0; y < height; y += step) {
		for (let x = 0; x < width; x += step) {
			if ((x / step + y / step) % 2 === 0) ctx.fillRect(x, y, step, step);
		}
	}
}

interface DrawParams {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	color: string;
	density: number;
	intensity: number;
}

interface ColorPairParams {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	colorB: string;
	colorC: string;
	density: number;
	intensity: number;
}

/* eslint-disable opencut/prefer-object-params -- Tiny math/color helpers stay readable at call sites with positional scalar args. */
function random(seed: number, index: number) {
	const value = Math.sin(seed * 999 + index * 777) * 10000;
	return value - Math.floor(value);
}

function clamp(value: number, min: number, max: number) {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}

function withAlpha(color: string, alpha: number) {
	const safeAlpha = clamp(alpha, 0, 1);
	if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
		const normalized =
			color.length === 4
				? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
				: color;
		const red = Number.parseInt(normalized.slice(1, 3), 16);
		const green = Number.parseInt(normalized.slice(3, 5), 16);
		const blue = Number.parseInt(normalized.slice(5, 7), 16);
		return `rgba(${red}, ${green}, ${blue}, ${safeAlpha})`;
	}
	return color;
}
/* eslint-enable opencut/prefer-object-params */
