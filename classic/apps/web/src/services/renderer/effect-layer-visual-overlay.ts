import type { ParamValues } from "@/params";
import type { BlendMode } from "@/rendering";
import { TICKS_PER_SECOND } from "@/wasm";

export type EffectLayerVisualOverlayKind =
	| "lens-flare"
	| "light-leak"
	| "sparkle"
	| "glow"
	| "film"
	| "glitch"
	| "scan-lines"
	| "flash"
	| "tint"
	| "particles"
	| "distortion";

export type EffectLayerVisualOverlay = {
	kind: EffectLayerVisualOverlayKind;
	label: string;
	intent?: string;
	intensity: number;
	opacity: number;
	blendMode: BlendMode;
	seed: number;
	localTimeSeconds: number;
	durationSeconds: number;
	frameIndex: number;
};

export function resolveEffectLayerVisualOverlay({
	effectType,
	effectParams,
	localTime,
	duration,
}: {
	effectType: string;
	effectParams: ParamValues;
	localTime: number;
	duration: number;
}): EffectLayerVisualOverlay | null {
	const label =
		readStringParam({ params: effectParams, key: "label" }) ||
		readStringParam({ params: effectParams, key: "requestedType" }) ||
		effectType ||
		"Custom AI edit";
	const intent =
		readStringParam({ params: effectParams, key: "intent" }) ||
		readStringParam({ params: effectParams, key: "kind" }) ||
		undefined;
	const specJson = readStringParam({ params: effectParams, key: "specJson" });
	const spec = parseJson(specJson);
	const text = [
		effectType,
		label,
		intent,
		readStringParam({ params: effectParams, key: "kind" }),
		readStringParam({ params: effectParams, key: "requestedType" }),
		specJson,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	const kind = inferVisualOverlayKind({ text });
	if (!kind) {
		return null;
	}

	const intensity = resolveIntensity({ params: effectParams, spec });
	const localTimeSeconds = Math.max(0, localTime / TICKS_PER_SECOND);
	const durationSeconds = Math.max(0.001, duration / TICKS_PER_SECOND);

	return {
		kind,
		label,
		intent,
		intensity,
		opacity: resolveOpacity({ kind, intensity }),
		blendMode: resolveBlendMode({ kind, spec }),
		seed: hashString(
			`${effectType}:${label}:${intent ?? ""}:${specJson ?? ""}`,
		),
		localTimeSeconds: roundForHash(localTimeSeconds),
		durationSeconds: roundForHash(durationSeconds),
		frameIndex: Math.max(0, Math.floor(localTimeSeconds * 24)),
	};
}

export function drawEffectLayerVisualOverlay({
	ctx,
	overlay,
	width,
	height,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	overlay: EffectLayerVisualOverlay;
	width: number;
	height: number;
}) {
	ctx.save();
	ctx.globalCompositeOperation = "source-over";
	switch (overlay.kind) {
		case "lens-flare":
			drawLensFlare({ ctx, overlay, width, height });
			break;
		case "light-leak":
			drawLightLeak({ ctx, overlay, width, height });
			break;
		case "sparkle":
			drawSparkle({ ctx, overlay, width, height });
			break;
		case "glow":
			drawGlow({ ctx, overlay, width, height });
			break;
		case "film":
			drawFilm({ ctx, overlay, width, height });
			break;
		case "glitch":
			drawGlitch({ ctx, overlay, width, height });
			break;
		case "scan-lines":
			drawScanLines({ ctx, overlay, width, height });
			break;
		case "flash":
			drawFlash({ ctx, overlay, width, height });
			break;
		case "tint":
			drawTint({ ctx, overlay, width, height });
			break;
		case "particles":
			drawParticles({ ctx, overlay, width, height });
			break;
		case "distortion":
			drawDistortion({ ctx, overlay, width, height });
			break;
	}
	ctx.restore();
}

function inferVisualOverlayKind({ text }: { text: string }) {
	if (
		hasAny(text, [
			"lens flare",
			"flare",
			"sunlight",
			"sun",
			"shine",
			"shiny",
			"glint",
			"light streak",
		])
	) {
		return "lens-flare";
	}
	if (hasAny(text, ["light leak", "leak", "film burn"])) {
		return "light-leak";
	}
	if (hasAny(text, ["sparkle", "shimmer", "bokeh", "twinkle"])) {
		return "sparkle";
	}
	if (
		hasAny(text, ["glow", "aura", "neon", "golden", "dreamy", "soft focus"])
	) {
		return "glow";
	}
	if (
		hasAny(text, [
			"film grain",
			"grain",
			"dust",
			"scratch",
			"scratches",
			"old footage",
			"8mm",
			"vhs",
			"retro film",
			"lofi",
		])
	) {
		return "film";
	}
	if (hasAny(text, ["scan lines", "scan-lines", "monitor lines"])) {
		return "scan-lines";
	}
	if (hasAny(text, ["glitch", "rgb split", "chromatic", "digital noise"])) {
		return "glitch";
	}
	if (hasAny(text, ["flash", "strobe", "flicker", "pulse"])) {
		return "flash";
	}
	if (
		hasAny(text, [
			"sepia",
			"warm",
			"cinematic",
			"hdr",
			"clarity",
			"sharpen",
			"4k",
			"detail enhance",
		])
	) {
		return "tint";
	}
	if (hasAny(text, ["rain", "snow", "smoke", "fire", "lightning"])) {
		return "particles";
	}
	if (
		hasAny(text, [
			"wave",
			"ripple",
			"fisheye",
			"kaleidoscope",
			"mirror",
			"pixelate",
			"magnifier",
			"motion trail",
			"afterimage",
		])
	) {
		return "distortion";
	}
	return null;
}

function drawLensFlare({ ctx, overlay, width, height }: DrawOverlayParams) {
	const pulse =
		0.86 + 0.14 * Math.sin(overlay.localTimeSeconds * 2.4 + overlay.seed);
	const x = width * (0.62 + seededUnit(overlay.seed, 1) * 0.28);
	const y = height * (0.12 + seededUnit(overlay.seed, 2) * 0.22);
	const radius = Math.max(width, height) * (0.22 + overlay.intensity * 0.16);
	const core = ctx.createRadialGradient(x, y, 0, x, y, radius);
	core.addColorStop(0, rgba(255, 255, 255, 0.95 * pulse));
	core.addColorStop(0.12, rgba(255, 236, 173, 0.62 * pulse));
	core.addColorStop(0.34, rgba(255, 172, 85, 0.26 * pulse));
	core.addColorStop(1, "rgba(255, 172, 85, 0)");
	ctx.fillStyle = core;
	ctx.fillRect(0, 0, width, height);

	const streakHeight = Math.max(6, height * 0.018) * (0.8 + overlay.intensity);
	const streak = ctx.createLinearGradient(0, y, width, y);
	streak.addColorStop(0, "rgba(255,255,255,0)");
	streak.addColorStop(0.42, rgba(255, 229, 152, 0.28 * pulse));
	streak.addColorStop(0.5, rgba(255, 255, 255, 0.62 * pulse));
	streak.addColorStop(0.58, rgba(255, 210, 135, 0.22 * pulse));
	streak.addColorStop(1, "rgba(255,255,255,0)");
	ctx.fillStyle = streak;
	ctx.fillRect(0, y - streakHeight / 2, width, streakHeight);

	const targetX = width * 0.22;
	const targetY = height * 0.74;
	for (let i = 0; i < 5; i++) {
		const t = 0.18 + i * 0.14;
		const ghostX = x + (targetX - x) * t;
		const ghostY = y + (targetY - y) * t;
		const ghostRadius = Math.max(width, height) * (0.018 + i * 0.008);
		drawRadialSpot({
			ctx,
			x: ghostX,
			y: ghostY,
			radius: ghostRadius,
			color: i % 2 === 0 ? [255, 210, 112] : [137, 215, 255],
			alpha: (0.18 - i * 0.02) * pulse,
		});
	}
}

function drawLightLeak({ ctx, overlay, width, height }: DrawOverlayParams) {
	const drift = Math.sin(overlay.localTimeSeconds * 0.7 + overlay.seed) * 0.08;
	drawRadialSpot({
		ctx,
		x: width * (0.08 + drift),
		y: height * 0.24,
		radius: Math.max(width, height) * 0.58,
		color: [255, 122, 61],
		alpha: 0.42 + overlay.intensity * 0.28,
	});
	drawRadialSpot({
		ctx,
		x: width * (0.92 - drift),
		y: height * 0.82,
		radius: Math.max(width, height) * 0.42,
		color: [255, 55, 149],
		alpha: 0.22 + overlay.intensity * 0.2,
	});
	const edge = ctx.createLinearGradient(0, 0, width, 0);
	edge.addColorStop(0, rgba(255, 188, 77, 0.55));
	edge.addColorStop(0.18, rgba(255, 102, 82, 0.18));
	edge.addColorStop(0.48, "rgba(255, 102, 82, 0)");
	edge.addColorStop(1, "rgba(255, 102, 82, 0)");
	ctx.fillStyle = edge;
	ctx.fillRect(0, 0, width, height);
}

function drawSparkle({ ctx, overlay, width, height }: DrawOverlayParams) {
	const count = Math.round(20 + overlay.intensity * 42);
	ctx.lineCap = "round";
	for (let i = 0; i < count; i++) {
		const x = seededUnit(overlay.seed, i * 5 + 1) * width;
		const y = seededUnit(overlay.seed, i * 5 + 2) * height;
		const size =
			(4 + seededUnit(overlay.seed, i * 5 + 3) * 12) *
			(0.75 + overlay.intensity);
		const twinkle = Math.max(
			0,
			Math.sin(
				overlay.localTimeSeconds * (2.2 + seededUnit(overlay.seed, i) * 3.8) +
					seededUnit(overlay.seed, i + 7) * Math.PI * 2,
			),
		);
		const alpha = (0.16 + twinkle * 0.62) * overlay.intensity;
		ctx.strokeStyle = rgba(255, 248, 213, alpha);
		ctx.lineWidth = Math.max(1, size * 0.12);
		ctx.beginPath();
		ctx.moveTo(x - size, y);
		ctx.lineTo(x + size, y);
		ctx.moveTo(x, y - size);
		ctx.lineTo(x, y + size);
		ctx.stroke();
		ctx.fillStyle = rgba(255, 255, 255, alpha * 0.9);
		ctx.beginPath();
		ctx.arc(x, y, Math.max(1.2, size * 0.16), 0, Math.PI * 2);
		ctx.fill();
	}
}

function drawGlow({ ctx, overlay, width, height }: DrawOverlayParams) {
	const text = `${overlay.label} ${overlay.intent ?? ""}`.toLowerCase();
	const warm = hasAny(text, ["golden", "sunset", "warm"]);
	const neon = hasAny(text, ["neon", "nightlife", "gaming"]);
	const color: [number, number, number] = warm
		? [255, 176, 76]
		: neon
			? [124, 95, 255]
			: [122, 205, 255];
	drawRadialSpot({
		ctx,
		x: width * 0.5,
		y: height * 0.48,
		radius: Math.max(width, height) * 0.62,
		color,
		alpha: 0.26 + overlay.intensity * 0.22,
	});
	drawRadialSpot({
		ctx,
		x: width * 0.26,
		y: height * 0.34,
		radius: Math.max(width, height) * 0.32,
		color: [255, 255, 255],
		alpha: 0.12 + overlay.intensity * 0.16,
	});
}

function drawFilm({ ctx, overlay, width, height }: DrawOverlayParams) {
	const text = `${overlay.label} ${overlay.intent ?? ""}`.toLowerCase();
	const lineStep = Math.max(3, Math.round(height / 260));
	ctx.fillStyle = hasAny(text, ["sepia", "old", "8mm", "retro"])
		? rgba(125, 82, 34, 0.14 + overlay.intensity * 0.12)
		: rgba(255, 255, 255, 0.05 + overlay.intensity * 0.06);
	ctx.fillRect(0, 0, width, height);

	ctx.fillStyle = "rgba(0, 0, 0, 0.16)";
	for (let y = 0; y < height; y += lineStep * 2) {
		ctx.fillRect(0, y, width, Math.max(1, lineStep * 0.35));
	}

	const specks = Math.round(160 + overlay.intensity * 420);
	ctx.fillStyle = "rgba(255, 255, 255, 0.34)";
	for (let i = 0; i < specks; i++) {
		const x = seededUnit(overlay.seed + overlay.frameIndex, i * 3 + 1) * width;
		const y = seededUnit(overlay.seed + overlay.frameIndex, i * 3 + 2) * height;
		const size = 0.6 + seededUnit(overlay.seed, i * 3 + 3) * 1.8;
		ctx.fillRect(x, y, size, size);
	}

	const scratches = hasAny(text, ["scratch", "scratches", "old", "8mm"])
		? 8
		: 3;
	ctx.strokeStyle = "rgba(255, 255, 255, 0.24)";
	ctx.lineWidth = Math.max(1, width * 0.001);
	for (let i = 0; i < scratches; i++) {
		const x = seededUnit(overlay.seed + overlay.frameIndex, 100 + i) * width;
		ctx.beginPath();
		ctx.moveTo(x, 0);
		ctx.lineTo(
			x + (seededUnit(overlay.seed, 130 + i) - 0.5) * width * 0.05,
			height,
		);
		ctx.stroke();
	}
}

function drawGlitch({ ctx, overlay, width, height }: DrawOverlayParams) {
	drawScanLines({ ctx, overlay, width, height });
	const bands = Math.round(5 + overlay.intensity * 10);
	for (let i = 0; i < bands; i++) {
		const y = seededUnit(overlay.seed + overlay.frameIndex, i * 4 + 1) * height;
		const h = Math.max(
			3,
			height * (0.01 + seededUnit(overlay.seed, i) * 0.035),
		);
		const xOffset =
			(seededUnit(overlay.seed + overlay.frameIndex, i * 4 + 2) - 0.5) *
			width *
			0.08;
		ctx.fillStyle =
			i % 2 === 0
				? rgba(255, 45, 93, 0.18 + overlay.intensity * 0.16)
				: rgba(24, 218, 255, 0.18 + overlay.intensity * 0.16);
		ctx.fillRect(Math.min(0, xOffset), y, width + Math.abs(xOffset), h);
	}
	ctx.fillStyle = rgba(255, 255, 255, 0.08 + overlay.intensity * 0.1);
	for (let i = 0; i < 18; i++) {
		const x = seededUnit(overlay.seed + overlay.frameIndex, 200 + i) * width;
		const y = seededUnit(overlay.seed + overlay.frameIndex, 260 + i) * height;
		ctx.fillRect(x, y, width * 0.05, Math.max(2, height * 0.008));
	}
}

function drawScanLines({ ctx, overlay, width, height }: DrawOverlayParams) {
	const step = Math.max(3, Math.round(height / 220));
	ctx.fillStyle = rgba(0, 0, 0, 0.22 + overlay.intensity * 0.18);
	for (let y = 0; y < height; y += step * 2) {
		ctx.fillRect(0, y, width, step);
	}
	ctx.fillStyle = rgba(55, 255, 210, 0.05 + overlay.intensity * 0.08);
	for (let y = step; y < height; y += step * 4) {
		ctx.fillRect(0, y, width, 1);
	}
}

function drawFlash({ ctx, overlay, width, height }: DrawOverlayParams) {
	const pulse =
		0.5 +
		0.5 *
			Math.sin(overlay.localTimeSeconds * Math.PI * 5 + overlay.seed * 0.017);
	const alpha = (0.18 + pulse * 0.54) * overlay.intensity;
	ctx.fillStyle = rgba(255, 255, 255, alpha);
	ctx.fillRect(0, 0, width, height);
}

function drawTint({ ctx, overlay, width, height }: DrawOverlayParams) {
	const text = `${overlay.label} ${overlay.intent ?? ""}`.toLowerCase();
	const color: [number, number, number] = hasAny(text, ["sepia", "old"])
		? [155, 102, 48]
		: hasAny(text, ["hdr", "clarity", "sharpen", "4k"])
			? [98, 170, 255]
			: [255, 184, 102];
	ctx.fillStyle = rgba(
		color[0],
		color[1],
		color[2],
		0.16 + overlay.intensity * 0.18,
	);
	ctx.fillRect(0, 0, width, height);

	const vignette = ctx.createRadialGradient(
		width / 2,
		height / 2,
		Math.min(width, height) * 0.16,
		width / 2,
		height / 2,
		Math.max(width, height) * 0.72,
	);
	vignette.addColorStop(0, "rgba(255,255,255,0.06)");
	vignette.addColorStop(1, "rgba(0,0,0,0.28)");
	ctx.fillStyle = vignette;
	ctx.fillRect(0, 0, width, height);
}

function drawParticles({ ctx, overlay, width, height }: DrawOverlayParams) {
	const text = `${overlay.label} ${overlay.intent ?? ""}`.toLowerCase();
	if (text.includes("lightning")) {
		ctx.strokeStyle = rgba(190, 225, 255, 0.65 + overlay.intensity * 0.25);
		ctx.lineWidth = Math.max(2, width * 0.003);
		ctx.beginPath();
		let x = width * (0.2 + seededUnit(overlay.seed, 1) * 0.6);
		let y = 0;
		ctx.moveTo(x, y);
		for (let i = 0; i < 8; i++) {
			x +=
				(seededUnit(overlay.seed + overlay.frameIndex, i) - 0.5) * width * 0.18;
			y += height / 8;
			ctx.lineTo(x, y);
		}
		ctx.stroke();
		return;
	}

	const isSnow = text.includes("snow");
	const isFire = text.includes("fire");
	const count = Math.round(45 + overlay.intensity * 80);
	ctx.strokeStyle = isFire
		? rgba(255, 115, 28, 0.44)
		: isSnow
			? rgba(255, 255, 255, 0.58)
			: rgba(180, 220, 255, 0.42);
	ctx.fillStyle = ctx.strokeStyle;
	ctx.lineWidth = Math.max(1, width * 0.001);
	for (let i = 0; i < count; i++) {
		const baseX = seededUnit(overlay.seed, i * 3 + 1) * width;
		const speed = 0.12 + seededUnit(overlay.seed, i * 3 + 2) * 0.36;
		const y =
			((seededUnit(overlay.seed, i * 3 + 3) +
				overlay.localTimeSeconds * speed) %
				1) *
			height;
		if (isSnow) {
			ctx.beginPath();
			ctx.arc(
				baseX,
				y,
				1.4 + seededUnit(overlay.seed, i) * 2.4,
				0,
				Math.PI * 2,
			);
			ctx.fill();
		} else if (isFire) {
			drawRadialSpot({
				ctx,
				x: baseX,
				y: height - y * 0.45,
				radius: height * 0.035,
				color: [255, 86, 22],
				alpha: 0.16,
			});
		} else {
			ctx.beginPath();
			ctx.moveTo(baseX, y);
			ctx.lineTo(baseX + width * 0.018, y + height * 0.06);
			ctx.stroke();
		}
	}
}

function drawDistortion({ ctx, overlay, width, height }: DrawOverlayParams) {
	ctx.strokeStyle = rgba(120, 220, 255, 0.14 + overlay.intensity * 0.18);
	ctx.lineWidth = Math.max(1, width * 0.0015);
	const rows = 12;
	for (let row = 0; row < rows; row++) {
		const y = (row / rows) * height;
		ctx.beginPath();
		for (let x = 0; x <= width; x += width / 28) {
			const wave =
				Math.sin(x * 0.018 + row * 0.9 + overlay.localTimeSeconds * 3) *
				height *
				0.012 *
				overlay.intensity;
			if (x === 0) {
				ctx.moveTo(x, y + wave);
			} else {
				ctx.lineTo(x, y + wave);
			}
		}
		ctx.stroke();
	}
	drawRadialSpot({
		ctx,
		x: width * 0.5,
		y: height * 0.5,
		radius: Math.min(width, height) * 0.24,
		color: [255, 255, 255],
		alpha: 0.07 + overlay.intensity * 0.08,
	});
}

function drawRadialSpot({
	ctx,
	x,
	y,
	radius,
	color,
	alpha,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	x: number;
	y: number;
	radius: number;
	color: [number, number, number];
	alpha: number;
}) {
	const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
	gradient.addColorStop(0, rgba(color[0], color[1], color[2], alpha));
	gradient.addColorStop(0.36, rgba(color[0], color[1], color[2], alpha * 0.34));
	gradient.addColorStop(1, rgba(color[0], color[1], color[2], 0));
	ctx.fillStyle = gradient;
	ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function resolveIntensity({
	params,
	spec,
}: {
	params: ParamValues;
	spec: unknown;
}): number {
	const direct =
		readNumberParam({ params, key: "intensity" }) ??
		findLargestNumberForKeys({
			value: spec,
			keys: ["intensity", "strength", "amount", "opacity"],
		});
	return clamp01((direct ?? 60) / 100);
}

function resolveOpacity({
	kind,
	intensity,
}: {
	kind: EffectLayerVisualOverlayKind;
	intensity: number;
}) {
	switch (kind) {
		case "film":
		case "scan-lines":
			return 0.62 + intensity * 0.28;
		case "flash":
			return 0.35 + intensity * 0.5;
		case "tint":
			return 0.45 + intensity * 0.28;
		default:
			return 0.55 + intensity * 0.38;
	}
}

function resolveBlendMode({
	kind,
	spec,
}: {
	kind: EffectLayerVisualOverlayKind;
	spec: unknown;
}): BlendMode {
	const specBlend = findStringForKeys({
		value: spec,
		keys: ["blend", "blendMode"],
	});
	if (specBlend && isBlendMode(specBlend)) {
		return specBlend;
	}

	switch (kind) {
		case "lens-flare":
		case "light-leak":
		case "sparkle":
		case "glow":
		case "flash":
			return "screen";
		case "film":
		case "scan-lines":
		case "glitch":
		case "tint":
		case "particles":
		case "distortion":
			return "overlay";
	}
}

function findLargestNumberForKeys({
	value,
	keys,
}: {
	value: unknown;
	keys: string[];
}): number | null {
	let largest: number | null = null;
	const visit = ({ current, key }: { current: unknown; key: string }) => {
		const keyMatches = keys.some((candidate) =>
			key.toLowerCase().includes(candidate.toLowerCase()),
		);
		if (keyMatches) {
			const numberValue =
				typeof current === "number"
					? current
					: typeof current === "string"
						? Number.parseFloat(current)
						: Number.NaN;
			if (Number.isFinite(numberValue)) {
				largest = Math.max(largest ?? 0, numberValue);
			}
		}
		if (Array.isArray(current)) {
			for (const item of current) {
				visit({ current: item, key });
			}
			return;
		}
		if (typeof current === "object" && current !== null) {
			for (const [nestedKey, nestedValue] of Object.entries(current)) {
				visit({ current: nestedValue, key: nestedKey });
			}
		}
	};
	visit({ current: value, key: "" });
	return largest;
}

function findStringForKeys({
	value,
	keys,
}: {
	value: unknown;
	keys: string[];
}): string | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	for (const [key, nestedValue] of Object.entries(value)) {
		if (
			typeof nestedValue === "string" &&
			keys.some((candidate) => key.toLowerCase() === candidate.toLowerCase())
		) {
			return nestedValue;
		}
		const nested = findStringForKeys({ value: nestedValue, keys });
		if (nested) {
			return nested;
		}
	}
	return null;
}

function readStringParam({
	params,
	key,
}: {
	params: ParamValues;
	key: string;
}): string | null {
	const value = params[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumberParam({
	params,
	key,
}: {
	params: ParamValues;
	key: string;
}): number | null {
	const value = params[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJson(value: string | null): unknown {
	if (!value) {
		return null;
	}
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function hasAny(...args: [text: string, needles: string[]]): boolean {
	const [text, needles] = args;
	return needles.some((needle) => text.includes(needle));
}

function isBlendMode(value: string): value is BlendMode {
	return (
		value === "normal" ||
		value === "darken" ||
		value === "multiply" ||
		value === "color-burn" ||
		value === "lighten" ||
		value === "screen" ||
		value === "plus-lighter" ||
		value === "color-dodge" ||
		value === "overlay" ||
		value === "soft-light" ||
		value === "hard-light" ||
		value === "difference" ||
		value === "exclusion" ||
		value === "hue" ||
		value === "saturation" ||
		value === "color" ||
		value === "luminosity"
	);
}

function seededUnit(...args: [seed: number, index: number]): number {
	const [seed, index] = args;
	let value = Math.imul(seed ^ Math.imul(index + 1, 0x9e3779b1), 0x85ebca6b);
	value ^= value >>> 13;
	value = Math.imul(value, 0xc2b2ae35);
	value ^= value >>> 16;
	return (value >>> 0) / 0xffffffff;
}

function hashString(value: string): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function rgba(
	...args: [red: number, green: number, blue: number, alpha: number]
): string {
	const [red, green, blue, alpha] = args;
	return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha))})`;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function roundForHash(value: number): number {
	return Math.round(value * 1000) / 1000;
}

type DrawOverlayParams = {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	overlay: EffectLayerVisualOverlay;
	width: number;
	height: number;
};
