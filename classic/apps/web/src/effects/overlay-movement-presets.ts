import type { ParamValues } from "@/params";
import type { BlendMode } from "@/rendering";

export const OVERLAY_MOVEMENT_KIND = "overlay-movement";

const DEFAULT_SFX = {
	whoosh: {
		assetId: "e061a3cf-5ba7-49fb-aab5-1b1527b0f3e3",
		name: "Whoosh",
	},
	riser: {
		assetId: "e2a87b99-8b0c-457e-8c57-53e8b2022c3c",
		name: "Riser",
	},
	snap: {
		assetId: "5414c56f-e1de-4d7e-bc26-26a6170d496c",
		name: "Snap",
	},
	click: {
		assetId: "ed2df1a9-ae6d-4e9d-a9ec-3a6254ebe1b8",
		name: "Click",
	},
} as const;

export type OverlayMovementCurve =
	| "curve-zoom"
	| "push-in"
	| "pull-out"
	| "instant-punch"
	| "flash-punch"
	| "handheld-punch"
	| "focus-hunt"
	| "shoulder-bump"
	| "zigzag-zoom"
	| "whip-left"
	| "whip-right"
	| "handheld-drift"
	| "impact-shake"
	| "bounce-zoom"
	| "alpha-blink"
	| "darken-room"
	| "vignette-push"
	| "vintage-snap"
	| "exposure-dip";

export interface OverlayMovementDefaultSfx {
	assetId: string;
	name: string;
}

export interface OverlayMovementSpec {
	version: 1;
	kind: typeof OVERLAY_MOVEMENT_KIND;
	presetId: string;
	curve: OverlayMovementCurve;
	zoom: number;
	panX?: number;
	panY?: number;
	rotate?: number;
	shake?: number;
	flash?: number;
	darken?: number;
	vignette?: number;
	colorOverlay?: string;
	colorOverlayAlpha?: number;
	colorOverlayBlendMode?: BlendMode;
	alphaPulse?: number;
	defaultSfx?: OverlayMovementDefaultSfx;
}

export interface OverlayMovementPreset {
	id: string;
	name: string;
	use: string;
	defaultDurationSeconds?: number;
	spec: OverlayMovementSpec;
	params: ParamValues;
}

export interface OverlayMovementFrame {
	presetId: string;
	label: string;
	progress: number;
	scale: number;
	translateX: number;
	translateY: number;
	rotate: number;
	flashAlpha: number;
	overlayColor: string | null;
	overlayAlpha: number;
	overlayBlendMode: BlendMode;
	vignetteAlpha: number;
}

function movement({
	id,
	name,
	use,
	curve,
	zoom,
	panX,
	panY,
	rotate = 0,
	shake = 0,
	flash = 0,
	darken = 0,
	vignette = 0,
	colorOverlay,
	colorOverlayAlpha = 0,
	colorOverlayBlendMode,
	alphaPulse = 0,
	defaultDurationSeconds,
	defaultSfx,
}: {
	id: string;
	name: string;
	use: string;
	defaultDurationSeconds?: number;
	curve: OverlayMovementCurve;
	zoom: number;
	panX?: number;
	panY?: number;
	rotate?: number;
	shake?: number;
	flash?: number;
	darken?: number;
	vignette?: number;
	colorOverlay?: string;
	colorOverlayAlpha?: number;
	colorOverlayBlendMode?: BlendMode;
	alphaPulse?: number;
	defaultSfx?: OverlayMovementDefaultSfx;
}): OverlayMovementPreset {
	const spec: OverlayMovementSpec = {
		version: 1,
		kind: OVERLAY_MOVEMENT_KIND,
		presetId: id,
		curve,
		zoom,
		...(panX !== undefined ? { panX } : {}),
		...(panY !== undefined ? { panY } : {}),
		...(rotate ? { rotate } : {}),
		...(shake ? { shake } : {}),
		...(flash ? { flash } : {}),
		...(darken ? { darken } : {}),
		...(vignette ? { vignette } : {}),
		...(colorOverlay ? { colorOverlay } : {}),
		...(colorOverlayAlpha ? { colorOverlayAlpha } : {}),
		...(colorOverlayBlendMode ? { colorOverlayBlendMode } : {}),
		...(alphaPulse ? { alphaPulse } : {}),
		...(defaultSfx ? { defaultSfx } : {}),
	};

	return {
		id,
		name,
		use,
		...(defaultDurationSeconds ? { defaultDurationSeconds } : {}),
		spec,
		params: buildOverlayMovementParams({ name, use, spec }),
	};
}

function buildOverlayMovementParams({
	name,
	use,
	spec,
}: {
	name: string;
	use: string;
	spec: OverlayMovementSpec;
}): ParamValues {
	return {
		label: name,
		kind: OVERLAY_MOVEMENT_KIND,
		requestedType: name,
		intent: use,
		specJson: JSON.stringify(spec, null, 2),
		status: "hosted",
		renderHint:
			"Camera movement adjustment layer. The movement is normalized to this layer duration.",
	};
}

export const OVERLAY_MOVEMENT_PRESETS: OverlayMovementPreset[] = [
	movement({
		id: "curve-zoom-in-out",
		name: "Curve Zoom In Out",
		use: "Smooth push in then pull back",
		curve: "curve-zoom",
		zoom: 0.26,
		defaultSfx: DEFAULT_SFX.whoosh,
	}),
	movement({
		id: "camera-zoom-in",
		name: "Camera Zoom In",
		use: "Slow natural push toward subject",
		curve: "push-in",
		zoom: 0.18,
		defaultSfx: DEFAULT_SFX.riser,
	}),
	movement({
		id: "camera-zoom-out",
		name: "Camera Zoom Out",
		use: "Reveal out from a tighter frame",
		curve: "pull-out",
		zoom: 0.2,
		defaultSfx: DEFAULT_SFX.riser,
	}),
	movement({
		id: "instant-zoom",
		name: "Instant Zoom",
		use: "Fast punch for cuts and beats",
		curve: "instant-punch",
		zoom: 0.32,
		shake: 0.012,
		defaultSfx: DEFAULT_SFX.snap,
	}),
	movement({
		id: "instant-zoom-handheld-long",
		name: "Instant Zoom Handheld",
		use: "Longer punch with camera operator sway",
		defaultDurationSeconds: 1.45,
		curve: "handheld-punch",
		zoom: 0.28,
		panX: 0.014,
		panY: 0.012,
		rotate: 1.15,
		shake: 0.018,
		defaultSfx: DEFAULT_SFX.snap,
	}),
	movement({
		id: "instant-zoom-focus-hunt",
		name: "Instant Focus Hunt",
		use: "Zoom hit with tiny focus-search drift",
		defaultDurationSeconds: 1.6,
		curve: "focus-hunt",
		zoom: 0.22,
		panX: 0.01,
		panY: 0.008,
		rotate: 0.6,
		shake: 0.01,
		defaultSfx: DEFAULT_SFX.snap,
	}),
	movement({
		id: "shoulder-bump-zoom",
		name: "Shoulder Bump Zoom",
		use: "Human shoulder bump then smooth settle",
		defaultDurationSeconds: 1.7,
		curve: "shoulder-bump",
		zoom: 0.24,
		panX: 0.026,
		panY: 0.015,
		rotate: -1.4,
		shake: 0.012,
		defaultSfx: DEFAULT_SFX.whoosh,
	}),
	movement({
		id: "breathing-punch-in",
		name: "Breathing Punch In",
		use: "Instant zoom with slower breathing handheld finish",
		defaultDurationSeconds: 1.9,
		curve: "handheld-punch",
		zoom: 0.2,
		panX: 0.016,
		panY: 0.014,
		rotate: 0.75,
		shake: 0.01,
		defaultSfx: DEFAULT_SFX.riser,
	}),
	movement({
		id: "camera-flash",
		name: "Camera Flash",
		use: "Flash hit with a tiny zoom",
		curve: "flash-punch",
		zoom: 0.16,
		flash: 0.78,
		defaultSfx: DEFAULT_SFX.click,
	}),
	movement({
		id: "flash-bloom-zoom",
		name: "Flash Bloom Zoom",
		use: "White flash bloom with a softer camera push",
		defaultDurationSeconds: 1.35,
		curve: "flash-punch",
		zoom: 0.19,
		flash: 0.58,
		vignette: 0.12,
		defaultSfx: DEFAULT_SFX.click,
	}),
	movement({
		id: "alpha-blink-hit",
		name: "Alpha Blink Hit",
		use: "Quick transparent blink that makes cuts pop",
		defaultDurationSeconds: 1.25,
		curve: "alpha-blink",
		zoom: 0.12,
		alphaPulse: 0.34,
		shake: 0.006,
		defaultSfx: DEFAULT_SFX.click,
	}),
	movement({
		id: "darken-room-push",
		name: "Darken Room Push",
		use: "Room dips darker while the camera pushes in",
		defaultDurationSeconds: 1.8,
		curve: "darken-room",
		zoom: 0.16,
		panX: 0.008,
		panY: 0.006,
		darken: 0.34,
		vignette: 0.42,
		defaultSfx: DEFAULT_SFX.riser,
	}),
	movement({
		id: "vignette-focus-push",
		name: "Vignette Focus Push",
		use: "Focus pull feeling with rich edge vignette",
		defaultDurationSeconds: 1.7,
		curve: "vignette-push",
		zoom: 0.17,
		panX: 0.008,
		panY: 0.01,
		vignette: 0.56,
		defaultSfx: DEFAULT_SFX.riser,
	}),
	movement({
		id: "vintage-snap-zoom",
		name: "Vintage Snap Zoom",
		use: "Warm vintage snap with vignette and hand movement",
		defaultDurationSeconds: 1.55,
		curve: "vintage-snap",
		zoom: 0.22,
		panX: 0.012,
		panY: 0.01,
		rotate: -0.9,
		shake: 0.012,
		vignette: 0.38,
		colorOverlay: "#9f6b36",
		colorOverlayAlpha: 0.18,
		colorOverlayBlendMode: "soft-light",
		defaultSfx: DEFAULT_SFX.snap,
	}),
	movement({
		id: "exposure-drop-hit",
		name: "Exposure Drop Hit",
		use: "Fast exposure dip before the image breathes back",
		defaultDurationSeconds: 1.45,
		curve: "exposure-dip",
		zoom: 0.14,
		darken: 0.46,
		shake: 0.008,
		defaultSfx: DEFAULT_SFX.snap,
	}),
	movement({
		id: "zigzag-natural-zoom",
		name: "Zigzag Natural Zoom",
		use: "Handheld zigzag while pushing in",
		curve: "zigzag-zoom",
		zoom: 0.2,
		panX: 0.028,
		panY: 0.018,
		rotate: 1.1,
		defaultSfx: DEFAULT_SFX.whoosh,
	}),
	movement({
		id: "whip-zoom-left",
		name: "Whip Zoom Left",
		use: "Fast left camera whip",
		curve: "whip-left",
		zoom: 0.3,
		panX: 0.09,
		rotate: -1.6,
		defaultSfx: DEFAULT_SFX.whoosh,
	}),
	movement({
		id: "whip-zoom-right",
		name: "Whip Zoom Right",
		use: "Fast right camera whip",
		curve: "whip-right",
		zoom: 0.3,
		panX: 0.09,
		rotate: 1.6,
		defaultSfx: DEFAULT_SFX.whoosh,
	}),
	movement({
		id: "handheld-breath",
		name: "Handheld Breath",
		use: "Subtle living camera drift",
		curve: "handheld-drift",
		zoom: 0.065,
		panX: 0.012,
		panY: 0.01,
		rotate: 0.45,
	}),
	movement({
		id: "impact-shake",
		name: "Impact Shake",
		use: "Decaying hit shake",
		curve: "impact-shake",
		zoom: 0.12,
		shake: 0.035,
		rotate: 2.4,
		defaultSfx: DEFAULT_SFX.snap,
	}),
	movement({
		id: "bounce-zoom",
		name: "Bounce Zoom",
		use: "Elastic zoom with rebound",
		curve: "bounce-zoom",
		zoom: 0.24,
		panY: 0.018,
		defaultSfx: DEFAULT_SFX.snap,
	}),
];

export function isOverlayMovementParams({
	params,
}: {
	params: ParamValues | Record<string, unknown>;
}): boolean {
	if (readStringParam({ params, key: "kind" }) === OVERLAY_MOVEMENT_KIND) {
		return true;
	}
	return readOverlayMovementSpec({ params }) !== null;
}

export function getOverlayMovementDefaultSfx({
	params,
}: {
	params: ParamValues | Record<string, unknown>;
}): OverlayMovementDefaultSfx | null {
	const spec = readOverlayMovementSpec({ params });
	return spec?.defaultSfx ?? null;
}

export function resolveOverlayMovementFrame({
	effectParams,
	localTime,
	duration,
	width,
	height,
}: {
	effectParams: ParamValues;
	localTime: number;
	duration: number;
	width: number;
	height: number;
}): OverlayMovementFrame | null {
	const spec = readOverlayMovementSpec({ params: effectParams });
	if (!spec) return null;

	const progress = clamp01(localTime / Math.max(1, duration));
	const eased = easeInOutSine(progress);
	const label =
		readStringParam({ params: effectParams, key: "label" }) ?? spec.presetId;
	const panX = spec.panX ?? 0;
	const panY = spec.panY ?? 0;
	const rotate = spec.rotate ?? 0;
	const shake = spec.shake ?? 0;
	const zoom = Math.max(0, spec.zoom);

	switch (spec.curve) {
		case "curve-zoom": {
			const pulse = Math.sin(progress * Math.PI);
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * pulse,
			});
		}
		case "push-in":
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * eased,
			});
		case "pull-out":
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * (1 - eased),
			});
		case "instant-punch": {
			const ramp = progress < 0.08 ? easeOutCubic(progress / 0.08) : 1;
			const settle =
				progress < 0.08 ? 1 : 1 - easeOutCubic((progress - 0.08) / 0.48);
			const decay = Math.max(0, ramp * settle);
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * decay,
				translateX: shakeOffset({
					progress,
					amount: shake,
					size: width,
					axis: 1,
				}),
				translateY: shakeOffset({
					progress,
					amount: shake,
					size: height,
					axis: 2,
				}),
				rotate: rotate * decay * 0.28,
			});
		}
		case "flash-punch": {
			const decay = 1 - easeOutCubic(progress);
			const flashWindow = 1 - easeOutCubic(progress / 0.24);
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * Math.max(0, decay),
				flashAlpha: clamp01((spec.flash ?? 0) * Math.max(0, flashWindow)),
			});
		}
		case "handheld-punch": {
			const hit =
				progress < 0.16
					? easeOutCubic(progress / 0.16)
					: 1 - easeOutCubic((progress - 0.16) / 0.68);
			const drift = 1 - progress * 0.35;
			return frame({
				spec,
				label,
				progress,
				scale:
					1 +
					zoom * Math.max(0, hit) +
					zoom * 0.035 * Math.sin(progress * Math.PI * 2.4),
				translateX:
					width * panX * Math.sin(progress * Math.PI * 2.1) * drift +
					shakeOffset({ progress, amount: shake, size: width, axis: 5 }),
				translateY:
					height * panY * Math.cos(progress * Math.PI * 1.7) * drift +
					shakeOffset({ progress, amount: shake, size: height, axis: 6 }),
				rotate:
					rotate * Math.sin(progress * Math.PI * 2) * drift +
					rotate * 0.18 * Math.sin(progress * Math.PI * 9) * Math.max(0, hit),
			});
		}
		case "focus-hunt": {
			const hunt = Math.sin(progress * Math.PI * 4) * (1 - progress);
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * (0.62 * eased + 0.16 * hunt),
				translateX: width * panX * hunt,
				translateY:
					height * panY * Math.cos(progress * Math.PI * 3) * (1 - progress),
				rotate: rotate * hunt,
			});
		}
		case "shoulder-bump": {
			const bump = Math.sin(progress * Math.PI) * (1 - progress * 0.25);
			const rebound = Math.sin(progress * Math.PI * 2) * (1 - progress);
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * bump,
				translateX:
					width * panX * (bump - rebound * 0.34) +
					shakeOffset({ progress, amount: shake, size: width, axis: 7 }),
				translateY:
					height * panY * (rebound * 0.8) +
					shakeOffset({ progress, amount: shake, size: height, axis: 8 }),
				rotate: rotate * bump + rotate * 0.26 * rebound,
			});
		}
		case "zigzag-zoom": {
			const wave = Math.sin(progress * Math.PI * 5);
			const waveY = Math.cos(progress * Math.PI * 3.5);
			const driftFade = 0.72 + (1 - progress) * 0.28;
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * eased,
				translateX: width * panX * wave * driftFade,
				translateY: height * panY * waveY * driftFade,
				rotate: rotate * Math.sin(progress * Math.PI * 4) * driftFade,
			});
		}
		case "whip-left":
		case "whip-right": {
			const direction = spec.curve === "whip-left" ? -1 : 1;
			const pulse = Math.sin(progress * Math.PI);
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * pulse,
				translateX: width * panX * direction * pulse,
				rotate: rotate * pulse,
			});
		}
		case "handheld-drift":
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * eased,
				translateX:
					width *
					panX *
					(0.65 * Math.sin(progress * Math.PI * 2.1) +
						0.35 * Math.sin(progress * Math.PI * 5.2)),
				translateY:
					height *
					panY *
					(0.72 * Math.cos(progress * Math.PI * 1.8) +
						0.28 * Math.sin(progress * Math.PI * 4.6)),
				rotate: rotate * Math.sin(progress * Math.PI * 2),
			});
		case "impact-shake": {
			const decay = 1 - easeOutCubic(progress);
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * Math.max(0, decay),
				translateX: shakeOffset({
					progress,
					amount: shake,
					size: width,
					axis: 3,
				}),
				translateY: shakeOffset({
					progress,
					amount: shake,
					size: height,
					axis: 4,
				}),
				rotate: rotate * Math.sin(progress * Math.PI * 18) * Math.max(0, decay),
			});
		}
		case "bounce-zoom": {
			const firstHit = Math.sin(progress * Math.PI);
			const rebound = Math.sin(progress * Math.PI * 2) * (1 - progress);
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * (firstHit + rebound * 0.22),
				translateY: height * panY * rebound,
			});
		}
		case "alpha-blink": {
			const hit = Math.sin(progress * Math.PI) * (1 - progress * 0.2);
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * hit,
				translateX: shakeOffset({
					progress,
					amount: shake,
					size: width,
					axis: 9,
				}),
				translateY: shakeOffset({
					progress,
					amount: shake,
					size: height,
					axis: 10,
				}),
			});
		}
		case "darken-room":
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * eased,
				translateX: width * panX * Math.sin(progress * Math.PI * 1.7),
				translateY: height * panY * Math.cos(progress * Math.PI * 1.3),
			});
		case "vignette-push":
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * eased,
				translateX: width * panX * Math.sin(progress * Math.PI * 2.2),
				translateY: height * panY * Math.cos(progress * Math.PI * 1.8),
				rotate: rotate * Math.sin(progress * Math.PI * 2),
			});
		case "vintage-snap": {
			const snap =
				progress < 0.12
					? easeOutCubic(progress / 0.12)
					: 1 - easeOutCubic((progress - 0.12) / 0.62);
			const drift = Math.max(0, 1 - progress * 0.45);
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * Math.max(0, snap),
				translateX:
					width * panX * Math.sin(progress * Math.PI * 2.6) * drift +
					shakeOffset({ progress, amount: shake, size: width, axis: 11 }),
				translateY:
					height * panY * Math.cos(progress * Math.PI * 2.1) * drift +
					shakeOffset({ progress, amount: shake, size: height, axis: 12 }),
				rotate: rotate * Math.max(0, snap),
			});
		}
		case "exposure-dip": {
			const dip = Math.sin(progress * Math.PI) * (1 - progress * 0.18);
			return frame({
				spec,
				label,
				progress,
				scale: 1 + zoom * dip,
				translateX: shakeOffset({
					progress,
					amount: shake,
					size: width,
					axis: 13,
				}),
				translateY: shakeOffset({
					progress,
					amount: shake,
					size: height,
					axis: 14,
				}),
			});
		}
	}
}

function frame({
	spec,
	label,
	progress,
	scale = 1,
	translateX = 0,
	translateY = 0,
	rotate = 0,
	flashAlpha = 0,
}: {
	spec: OverlayMovementSpec;
	label: string;
	progress: number;
	scale?: number;
	translateX?: number;
	translateY?: number;
	rotate?: number;
	flashAlpha?: number;
}): OverlayMovementFrame {
	const pulse = Math.sin(progress * Math.PI);
	const alphaPulse =
		(spec.alphaPulse ?? 0) *
		Math.max(0, Math.sin(progress * Math.PI * 5)) *
		(0.62 + (1 - progress) * 0.38);
	const hasDarken = (spec.darken ?? 0) > 0;
	const overlayColor = hasDarken
		? "#000000"
		: alphaPulse > 0
			? "#ffffff"
			: (spec.colorOverlay ?? null);
	const baseOverlayAlpha = hasDarken
		? (spec.darken ?? 0) * pulse
		: spec.colorOverlay
			? (spec.colorOverlayAlpha ?? 0) * pulse
			: alphaPulse;

	return {
		presetId: spec.presetId,
		label,
		progress,
		scale: Math.max(0.01, scale),
		translateX,
		translateY,
		rotate,
		flashAlpha: clamp01(flashAlpha),
		overlayColor,
		overlayAlpha: clamp01(baseOverlayAlpha),
		overlayBlendMode:
			alphaPulse > 0 ? "screen" : (spec.colorOverlayBlendMode ?? "normal"),
		vignetteAlpha: clamp01((spec.vignette ?? 0) * (0.2 + pulse * 0.8)),
	};
}

function readOverlayMovementSpec({
	params,
}: {
	params: ParamValues | Record<string, unknown>;
}): OverlayMovementSpec | null {
	const spec = parseJson(readStringParam({ params, key: "specJson" }));
	if (!isOverlayMovementSpec(spec)) return null;
	return spec;
}

function isOverlayMovementSpec(value: unknown): value is OverlayMovementSpec {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const item = value as Record<string, unknown>;
	return (
		item.kind === OVERLAY_MOVEMENT_KIND &&
		item.version === 1 &&
		typeof item.presetId === "string" &&
		isMovementCurve(item.curve) &&
		typeof item.zoom === "number" &&
		Number.isFinite(item.zoom)
	);
}

function isMovementCurve(value: unknown): value is OverlayMovementCurve {
	return (
		value === "curve-zoom" ||
		value === "push-in" ||
		value === "pull-out" ||
		value === "instant-punch" ||
		value === "flash-punch" ||
		value === "handheld-punch" ||
		value === "focus-hunt" ||
		value === "shoulder-bump" ||
		value === "zigzag-zoom" ||
		value === "whip-left" ||
		value === "whip-right" ||
		value === "handheld-drift" ||
		value === "impact-shake" ||
		value === "bounce-zoom" ||
		value === "alpha-blink" ||
		value === "darken-room" ||
		value === "vignette-push" ||
		value === "vintage-snap" ||
		value === "exposure-dip"
	);
}

function shakeOffset({
	progress,
	amount,
	size,
	axis,
}: {
	progress: number;
	amount: number;
	size: number;
	axis: number;
}): number {
	const decay = 1 - easeOutCubic(progress);
	return (
		size *
		amount *
		Math.sin(progress * Math.PI * (axis % 2 === 0 ? 15 : 17)) *
		Math.max(0, decay)
	);
}

function easeInOutSine(value: number): number {
	const t = clamp01(value);
	return -(Math.cos(Math.PI * t) - 1) / 2;
}

function easeOutCubic(value: number): number {
	const t = clamp01(value);
	return 1 - Math.pow(1 - t, 3);
}

function readStringParam({
	params,
	key,
}: {
	params: ParamValues | Record<string, unknown>;
	key: string;
}): string | null {
	const value = params[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseJson(value: string | null): unknown {
	if (!value) return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}
