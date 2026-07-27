import type {
	TransitionPreset,
	TransitionProperty,
	TransitionRecipe,
	TransitionState,
} from "./types";

export const CONTROLLED_TRANSITION_PROPERTIES: TransitionProperty[] = [
	"opacity",
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
	"transform.rotate",
	"transition.shatter",
	"background.paddingX",
	"background.paddingY",
	"background.offsetX",
	"background.offsetY",
	"background.cornerRadius",
];

function preset({
	id,
	label,
	state,
	recipe,
	keywords = [],
}: {
	id: string;
	label: string;
	state: TransitionState;
	recipe?: TransitionRecipe;
	keywords?: string[];
}): TransitionPreset {
	return { id, label, state, recipe, keywords };
}

const keys = (...points: Array<[number, number]>) =>
	points.map(([at, value]) => ({ at, value }));

const softOpacity = keys([0, 0], [0.16, 0.82], [0.34, 1], [1, 1]);
const quickOpacity = keys([0, 0], [0.08, 1], [1, 1]);
const cinematicOpacity = keys([0, 0], [0.2, 0.36], [0.58, 0.92], [1, 1]);

function premiumPreset({
	id,
	label,
	recipe,
	keywords = [],
}: {
	id: string;
	label: string;
	recipe: TransitionRecipe;
	keywords?: string[];
}): TransitionPreset {
	return preset({
		id,
		label,
		state: {},
		recipe,
		keywords: ["premium", ...keywords],
	});
}

function settleOffset({
	from,
	counter = 0.035,
}: {
	from: number;
	counter?: number;
}) {
	return keys(
		[0, from],
		[0.58, -from * counter],
		[0.82, from * counter * 0.35],
		[1, 0],
	);
}

function settleScale({
	from,
	overshoot = from < 1 ? 1.035 : 0.985,
}: {
	from: number;
	overshoot?: number;
}) {
	return keys([0, from], [0.58, overshoot], [0.82, 1], [1, 1]);
}

function glidePreset({
	id,
	label,
	x = 0,
	y = 0,
	keywords = [],
}: {
	id: string;
	label: string;
	x?: number;
	y?: number;
	keywords?: string[];
}) {
	const recipe: TransitionRecipe = {
		opacity: softOpacity,
		"transform.scaleX": settleScale({ from: 0.985, overshoot: 1.012 }),
		"transform.scaleY": settleScale({ from: 0.985, overshoot: 1.012 }),
	};
	if (x !== 0) recipe["transform.positionX"] = settleOffset({ from: x });
	if (y !== 0) recipe["transform.positionY"] = settleOffset({ from: y });
	return premiumPreset({ id, label, recipe, keywords: ["glide", ...keywords] });
}

function whipPreset({
	id,
	label,
	x = 0,
	y = 0,
	rotate = 0,
	keywords = [],
}: {
	id: string;
	label: string;
	x?: number;
	y?: number;
	rotate?: number;
	keywords?: string[];
}) {
	const recipe: TransitionRecipe = {
		opacity: quickOpacity,
		"transform.scaleX": keys([0, 1.08], [0.46, 0.985], [1, 1]),
		"transform.scaleY": keys([0, 1.08], [0.46, 0.985], [1, 1]),
	};
	if (x !== 0) {
		recipe["transform.positionX"] = keys(
			[0, x],
			[0.22, -x * 0.16],
			[0.52, x * 0.045],
			[1, 0],
		);
	}
	if (y !== 0) {
		recipe["transform.positionY"] = keys(
			[0, y],
			[0.22, -y * 0.16],
			[0.52, y * 0.045],
			[1, 0],
		);
	}
	if (rotate !== 0) {
		recipe["transform.rotate"] = keys(
			[0, rotate],
			[0.42, -rotate * 0.14],
			[1, 0],
		);
	}
	return premiumPreset({ id, label, recipe, keywords: ["whip", ...keywords] });
}

function zoomPreset({
	id,
	label,
	scale,
	overshoot,
	rotate = 0,
	keywords = [],
}: {
	id: string;
	label: string;
	scale: number;
	overshoot?: number;
	rotate?: number;
	keywords?: string[];
}) {
	const recipe: TransitionRecipe = {
		opacity: cinematicOpacity,
		"transform.scaleX": settleScale({ from: scale, overshoot }),
		"transform.scaleY": settleScale({ from: scale, overshoot }),
	};
	if (rotate !== 0) {
		recipe["transform.rotate"] = keys(
			[0, rotate],
			[0.68, -rotate * 0.08],
			[1, 0],
		);
	}
	return premiumPreset({ id, label, recipe, keywords: ["zoom", ...keywords] });
}

function shutterPreset({
	id,
	label,
	axis,
	offset = 0,
	keywords = [],
}: {
	id: string;
	label: string;
	axis: "x" | "y";
	offset?: number;
	keywords?: string[];
}) {
	const recipe: TransitionRecipe = {
		opacity: keys([0, 0], [0.04, 1], [1, 1]),
	};
	if (axis === "x") {
		recipe["transform.scaleX"] = keys([0, 0.035], [0.62, 1.045], [1, 1]);
		if (offset !== 0) {
			recipe["transform.positionX"] = settleOffset({
				from: offset,
				counter: 0.02,
			});
		}
	} else {
		recipe["transform.scaleY"] = keys([0, 0.035], [0.62, 1.045], [1, 1]);
		if (offset !== 0) {
			recipe["transform.positionY"] = settleOffset({
				from: offset,
				counter: 0.02,
			});
		}
	}
	return premiumPreset({
		id,
		label,
		recipe,
		keywords: ["wipe", "shutter", ...keywords],
	});
}

function hingePreset({
	id,
	label,
	x = 0,
	y = 0,
	rotate,
	keywords = [],
}: {
	id: string;
	label: string;
	x?: number;
	y?: number;
	rotate: number;
	keywords?: string[];
}) {
	const recipe: TransitionRecipe = {
		opacity: keys([0, 0], [0.12, 0.9], [1, 1]),
		"transform.rotate": keys(
			[0, rotate],
			[0.5, -rotate * 0.09],
			[0.78, rotate * 0.025],
			[1, 0],
		),
		"transform.scaleX": keys([0, 0.92], [0.6, 1.015], [1, 1]),
		"transform.scaleY": keys([0, 0.92], [0.6, 1.015], [1, 1]),
	};
	if (x !== 0) {
		recipe["transform.positionX"] = settleOffset({ from: x, counter: 0.025 });
	}
	if (y !== 0) {
		recipe["transform.positionY"] = settleOffset({ from: y, counter: 0.025 });
	}
	return premiumPreset({
		id,
		label,
		recipe,
		keywords: ["hinge", "rotate", ...keywords],
	});
}

const PREMIUM_TRANSITION_PRESETS: TransitionPreset[] = [
	glidePreset({
		id: "cinematic-glide-left",
		label: "Cinematic Glide Left",
		x: -220,
		keywords: ["cinematic"],
	}),
	glidePreset({
		id: "cinematic-glide-right",
		label: "Cinematic Glide Right",
		x: 220,
		keywords: ["cinematic"],
	}),
	glidePreset({
		id: "cinematic-glide-up",
		label: "Cinematic Glide Up",
		y: -140,
		keywords: ["cinematic"],
	}),
	glidePreset({
		id: "cinematic-glide-down",
		label: "Cinematic Glide Down",
		y: 140,
		keywords: ["cinematic"],
	}),
	glidePreset({
		id: "silk-drift-left",
		label: "Silk Drift Left",
		x: -95,
		keywords: ["soft"],
	}),
	glidePreset({
		id: "silk-drift-right",
		label: "Silk Drift Right",
		x: 95,
		keywords: ["soft"],
	}),
	glidePreset({
		id: "silk-rise",
		label: "Silk Rise",
		y: 72,
		keywords: ["soft"],
	}),
	glidePreset({
		id: "velvet-drop",
		label: "Velvet Drop",
		y: -72,
		keywords: ["soft"],
	}),
	whipPreset({
		id: "whip-pan-left",
		label: "Whip Pan Left",
		x: -560,
		rotate: -4,
		keywords: ["pan"],
	}),
	whipPreset({
		id: "whip-pan-right",
		label: "Whip Pan Right",
		x: 560,
		rotate: 4,
		keywords: ["pan"],
	}),
	whipPreset({
		id: "whip-pan-up",
		label: "Whip Pan Up",
		y: -360,
		rotate: 3,
		keywords: ["pan"],
	}),
	whipPreset({
		id: "whip-pan-down",
		label: "Whip Pan Down",
		y: 360,
		rotate: -3,
		keywords: ["pan"],
	}),
	whipPreset({
		id: "snap-pan-left",
		label: "Snap Pan Left",
		x: -320,
		rotate: -2,
		keywords: ["snap"],
	}),
	whipPreset({
		id: "snap-pan-right",
		label: "Snap Pan Right",
		x: 320,
		rotate: 2,
		keywords: ["snap"],
	}),
	whipPreset({
		id: "snap-pan-up",
		label: "Snap Pan Up",
		y: -220,
		rotate: 2,
		keywords: ["snap"],
	}),
	whipPreset({
		id: "snap-pan-down",
		label: "Snap Pan Down",
		y: 220,
		rotate: -2,
		keywords: ["snap"],
	}),
	glidePreset({
		id: "diagonal-sweep-tl",
		label: "Diagonal Sweep TL",
		x: -240,
		y: -135,
		keywords: ["diagonal"],
	}),
	glidePreset({
		id: "diagonal-sweep-tr",
		label: "Diagonal Sweep TR",
		x: 240,
		y: -135,
		keywords: ["diagonal"],
	}),
	glidePreset({
		id: "diagonal-sweep-bl",
		label: "Diagonal Sweep BL",
		x: -240,
		y: 135,
		keywords: ["diagonal"],
	}),
	glidePreset({
		id: "diagonal-sweep-br",
		label: "Diagonal Sweep BR",
		x: 240,
		y: 135,
		keywords: ["diagonal"],
	}),
	zoomPreset({
		id: "dolly-zoom-in",
		label: "Dolly Zoom In",
		scale: 1.42,
		overshoot: 0.985,
		keywords: ["cinematic"],
	}),
	zoomPreset({
		id: "dolly-zoom-out",
		label: "Dolly Zoom Out",
		scale: 0.62,
		overshoot: 1.035,
		keywords: ["cinematic"],
	}),
	zoomPreset({
		id: "close-focus",
		label: "Close Focus",
		scale: 1.18,
		overshoot: 0.995,
		keywords: ["subtle"],
	}),
	zoomPreset({
		id: "wide-focus",
		label: "Wide Focus",
		scale: 0.82,
		overshoot: 1.018,
		keywords: ["subtle"],
	}),
	zoomPreset({
		id: "crash-zoom-in",
		label: "Crash Zoom In",
		scale: 2.15,
		overshoot: 0.92,
		rotate: -1.5,
		keywords: ["impact"],
	}),
	zoomPreset({
		id: "crash-zoom-out",
		label: "Crash Zoom Out",
		scale: 0.18,
		overshoot: 1.08,
		rotate: 1.5,
		keywords: ["impact"],
	}),
	zoomPreset({
		id: "spiral-zoom-left",
		label: "Spiral Zoom Left",
		scale: 0.2,
		overshoot: 1.04,
		rotate: -120,
		keywords: ["spiral"],
	}),
	zoomPreset({
		id: "spiral-zoom-right",
		label: "Spiral Zoom Right",
		scale: 0.2,
		overshoot: 1.04,
		rotate: 120,
		keywords: ["spiral"],
	}),
	shutterPreset({
		id: "shutter-horizontal",
		label: "Shutter Horizontal",
		axis: "x",
		keywords: ["editorial"],
	}),
	shutterPreset({
		id: "shutter-vertical",
		label: "Shutter Vertical",
		axis: "y",
		keywords: ["editorial"],
	}),
	shutterPreset({
		id: "shutter-left",
		label: "Shutter Left",
		axis: "x",
		offset: -130,
		keywords: ["editorial"],
	}),
	shutterPreset({
		id: "shutter-right",
		label: "Shutter Right",
		axis: "x",
		offset: 130,
		keywords: ["editorial"],
	}),
	shutterPreset({
		id: "shutter-up",
		label: "Shutter Up",
		axis: "y",
		offset: -90,
		keywords: ["editorial"],
	}),
	shutterPreset({
		id: "shutter-down",
		label: "Shutter Down",
		axis: "y",
		offset: 90,
		keywords: ["editorial"],
	}),
	hingePreset({
		id: "hinge-left-pro",
		label: "Hinge Left Pro",
		x: -95,
		rotate: -32,
	}),
	hingePreset({
		id: "hinge-right-pro",
		label: "Hinge Right Pro",
		x: 95,
		rotate: 32,
	}),
	hingePreset({
		id: "hinge-top-pro",
		label: "Hinge Top Pro",
		y: -72,
		rotate: 18,
	}),
	hingePreset({
		id: "hinge-bottom-pro",
		label: "Hinge Bottom Pro",
		y: 72,
		rotate: -18,
	}),
	premiumPreset({
		id: "carousel-left",
		label: "Carousel Left",
		keywords: ["carousel", "rotate"],
		recipe: {
			opacity: softOpacity,
			"transform.positionX": keys([0, -340], [0.54, 28], [0.8, -8], [1, 0]),
			"transform.scaleX": keys([0, 0.72], [0.58, 1.035], [1, 1]),
			"transform.scaleY": keys([0, 0.72], [0.58, 1.035], [1, 1]),
			"transform.rotate": keys([0, -12], [0.62, 2], [1, 0]),
		},
	}),
	premiumPreset({
		id: "carousel-right",
		label: "Carousel Right",
		keywords: ["carousel", "rotate"],
		recipe: {
			opacity: softOpacity,
			"transform.positionX": keys([0, 340], [0.54, -28], [0.8, 8], [1, 0]),
			"transform.scaleX": keys([0, 0.72], [0.58, 1.035], [1, 1]),
			"transform.scaleY": keys([0, 0.72], [0.58, 1.035], [1, 1]),
			"transform.rotate": keys([0, 12], [0.62, -2], [1, 0]),
		},
	}),
	premiumPreset({
		id: "orbit-left",
		label: "Orbit Left",
		keywords: ["orbit", "rotate"],
		recipe: {
			opacity: softOpacity,
			"transform.positionX": keys([0, -260], [0.45, 34], [1, 0]),
			"transform.positionY": keys([0, 88], [0.52, -14], [1, 0]),
			"transform.scaleX": settleScale({ from: 0.68, overshoot: 1.025 }),
			"transform.scaleY": settleScale({ from: 0.68, overshoot: 1.025 }),
			"transform.rotate": keys([0, -24], [0.58, 3], [1, 0]),
		},
	}),
	premiumPreset({
		id: "orbit-right",
		label: "Orbit Right",
		keywords: ["orbit", "rotate"],
		recipe: {
			opacity: softOpacity,
			"transform.positionX": keys([0, 260], [0.45, -34], [1, 0]),
			"transform.positionY": keys([0, 88], [0.52, -14], [1, 0]),
			"transform.scaleX": settleScale({ from: 0.68, overshoot: 1.025 }),
			"transform.scaleY": settleScale({ from: 0.68, overshoot: 1.025 }),
			"transform.rotate": keys([0, 24], [0.58, -3], [1, 0]),
		},
	}),
	premiumPreset({
		id: "liquid-pop",
		label: "Liquid Pop",
		keywords: ["pop", "bounce"],
		recipe: {
			opacity: quickOpacity,
			"transform.scaleX": keys(
				[0, 0.18],
				[0.28, 1.32],
				[0.48, 0.86],
				[0.72, 1.06],
				[1, 1],
			),
			"transform.scaleY": keys(
				[0, 1.7],
				[0.28, 0.74],
				[0.48, 1.18],
				[0.72, 0.96],
				[1, 1],
			),
		},
	}),
	premiumPreset({
		id: "magnetic-pop",
		label: "Magnetic Pop",
		keywords: ["pop", "snap"],
		recipe: {
			opacity: keys([0, 0], [0.06, 1], [1, 1]),
			"transform.positionY": keys([0, 34], [0.24, -18], [0.52, 7], [1, 0]),
			"transform.scaleX": keys([0, 0.55], [0.3, 1.18], [0.58, 0.96], [1, 1]),
			"transform.scaleY": keys([0, 0.55], [0.3, 1.18], [0.58, 0.96], [1, 1]),
		},
	}),
	premiumPreset({
		id: "editorial-slam",
		label: "Editorial Slam",
		keywords: ["impact", "editorial"],
		recipe: {
			opacity: keys([0, 0], [0.05, 1], [1, 1]),
			"transform.positionX": keys([0, -180], [0.22, 18], [0.42, -7], [1, 0]),
			"transform.scaleX": keys([0, 1.18], [0.2, 0.96], [0.48, 1.02], [1, 1]),
			"transform.scaleY": keys([0, 1.18], [0.2, 0.96], [0.48, 1.02], [1, 1]),
			"transform.rotate": keys([0, -2.5], [0.3, 0.8], [1, 0]),
		},
	}),
	premiumPreset({
		id: "prism-snap",
		label: "Prism Snap",
		keywords: ["snap", "glitch"],
		recipe: {
			opacity: keys([0, 0], [0.06, 0.75], [0.12, 0.3], [0.2, 1], [1, 1]),
			"transform.positionX": keys(
				[0, -46],
				[0.1, 34],
				[0.18, -18],
				[0.32, 8],
				[1, 0],
			),
			"transform.positionY": keys([0, 16], [0.12, -10], [0.24, 5], [1, 0]),
			"transform.scaleX": keys([0, 1.12], [0.34, 0.98], [1, 1]),
			"transform.scaleY": keys([0, 0.92], [0.34, 1.02], [1, 1]),
		},
	}),
	premiumPreset({
		id: "film-dissolve-pro",
		label: "Film Dissolve Pro",
		keywords: ["film", "dissolve"],
		recipe: {
			opacity: keys(
				[0, 0],
				[0.18, 0.42],
				[0.34, 0.32],
				[0.58, 0.82],
				[0.76, 0.74],
				[1, 1],
			),
			"transform.scaleX": keys([0, 1.035], [1, 1]),
			"transform.scaleY": keys([0, 1.035], [1, 1]),
		},
	}),
	premiumPreset({
		id: "luxe-fade",
		label: "Luxe Fade",
		keywords: ["fade", "cinematic"],
		recipe: {
			opacity: keys([0, 0], [0.3, 0.5], [0.72, 0.95], [1, 1]),
			"transform.scaleX": keys([0, 1.025], [1, 1]),
			"transform.scaleY": keys([0, 1.025], [1, 1]),
		},
	}),
	premiumPreset({
		id: "focus-bloom",
		label: "Focus Bloom",
		keywords: ["focus", "fade"],
		recipe: {
			opacity: keys([0, 0], [0.14, 0.42], [0.36, 1], [1, 1]),
			"transform.scaleX": keys([0, 1.12], [0.68, 0.992], [1, 1]),
			"transform.scaleY": keys([0, 1.12], [0.68, 0.992], [1, 1]),
		},
	}),
	premiumPreset({
		id: "lower-third-reveal-left",
		label: "Lower Third Reveal L",
		keywords: ["text", "lower-third"],
		recipe: {
			opacity: softOpacity,
			"transform.positionX": settleOffset({ from: -150 }),
			"background.paddingX": keys([0, -22], [0.58, 8], [1, 0]),
			"background.offsetX": keys([0, -42], [0.62, 4], [1, 0]),
			"background.cornerRadius": keys([0, 2], [0.5, 18], [1, 0]),
		},
	}),
	premiumPreset({
		id: "lower-third-reveal-right",
		label: "Lower Third Reveal R",
		keywords: ["text", "lower-third"],
		recipe: {
			opacity: softOpacity,
			"transform.positionX": settleOffset({ from: 150 }),
			"background.paddingX": keys([0, -22], [0.58, 8], [1, 0]),
			"background.offsetX": keys([0, 42], [0.62, -4], [1, 0]),
			"background.cornerRadius": keys([0, 2], [0.5, 18], [1, 0]),
		},
	}),
	premiumPreset({
		id: "title-card-bloom",
		label: "Title Card Bloom",
		keywords: ["text", "title"],
		recipe: {
			opacity: cinematicOpacity,
			"transform.scaleX": settleScale({ from: 0.88, overshoot: 1.025 }),
			"transform.scaleY": settleScale({ from: 0.88, overshoot: 1.025 }),
			"background.paddingX": keys([0, -18], [0.55, 10], [1, 0]),
			"background.paddingY": keys([0, -10], [0.55, 6], [1, 0]),
			"background.cornerRadius": keys([0, 28], [1, 0]),
		},
	}),
	premiumPreset({
		id: "caption-lift-pro",
		label: "Caption Lift Pro",
		keywords: ["text", "caption"],
		recipe: {
			opacity: softOpacity,
			"transform.positionY": keys([0, 44], [0.52, -6], [1, 0]),
			"background.offsetY": keys([0, 22], [0.6, -3], [1, 0]),
			"background.paddingX": keys([0, -12], [0.62, 5], [1, 0]),
		},
	}),
	premiumPreset({
		id: "pill-expand",
		label: "Pill Expand",
		keywords: ["text", "pill"],
		recipe: {
			opacity: quickOpacity,
			"transform.scaleX": keys([0, 0.28], [0.46, 1.08], [1, 1]),
			"transform.scaleY": keys([0, 0.92], [0.46, 1.03], [1, 1]),
			"background.paddingX": keys([0, -30], [0.48, 12], [1, 0]),
			"background.cornerRadius": keys([0, 36], [1, 0]),
		},
	}),
	premiumPreset({
		id: "subtitle-snap",
		label: "Subtitle Snap",
		keywords: ["text", "caption", "snap"],
		recipe: {
			opacity: keys([0, 0], [0.08, 1], [1, 1]),
			"transform.positionY": keys([0, 22], [0.24, -8], [0.48, 3], [1, 0]),
			"transform.scaleX": keys([0, 0.96], [0.28, 1.035], [1, 1]),
			"transform.scaleY": keys([0, 0.96], [0.28, 1.035], [1, 1]),
			"background.paddingY": keys([0, -6], [0.36, 5], [1, 0]),
		},
	}),
];

export const TRANSITION_PRESETS: TransitionPreset[] = [
	preset({ id: "none", label: "None", state: {}, keywords: ["clear"] }),
	preset({
		id: "fade",
		label: "Fade",
		state: { opacity: 0 },
		keywords: ["opacity"],
	}),
	preset({
		id: "slide-left",
		label: "Slide Left",
		state: { "transform.positionX": -120, opacity: 0 },
		keywords: ["move"],
	}),
	preset({
		id: "slide-right",
		label: "Slide Right",
		state: { "transform.positionX": 120, opacity: 0 },
		keywords: ["move"],
	}),
	preset({
		id: "slide-up",
		label: "Slide Up",
		state: { "transform.positionY": -120, opacity: 0 },
		keywords: ["move"],
	}),
	preset({
		id: "slide-down",
		label: "Slide Down",
		state: { "transform.positionY": 120, opacity: 0 },
		keywords: ["move"],
	}),
	preset({
		id: "push-left",
		label: "Push Left",
		state: { "transform.positionX": -240 },
		keywords: ["push"],
	}),
	preset({
		id: "push-right",
		label: "Push Right",
		state: { "transform.positionX": 240 },
		keywords: ["push"],
	}),
	preset({
		id: "push-up",
		label: "Push Up",
		state: { "transform.positionY": -240 },
		keywords: ["push"],
	}),
	preset({
		id: "push-down",
		label: "Push Down",
		state: { "transform.positionY": 240 },
		keywords: ["push"],
	}),
	preset({
		id: "zoom-in",
		label: "Zoom In",
		state: { "transform.scaleX": 0.25, "transform.scaleY": 0.25, opacity: 0 },
		keywords: ["scale"],
	}),
	preset({
		id: "zoom-out",
		label: "Zoom Out",
		state: { "transform.scaleX": 1.8, "transform.scaleY": 1.8, opacity: 0 },
		keywords: ["scale"],
	}),
	preset({
		id: "pop",
		label: "Pop",
		state: { "transform.scaleX": 0, "transform.scaleY": 0, opacity: 0 },
		keywords: ["scale"],
	}),
	preset({
		id: "shrink",
		label: "Shrink",
		state: { "transform.scaleX": 0.7, "transform.scaleY": 0.7, opacity: 0 },
		keywords: ["scale"],
	}),
	preset({
		id: "grow",
		label: "Grow",
		state: { "transform.scaleX": 1.35, "transform.scaleY": 1.35, opacity: 0 },
		keywords: ["scale"],
	}),
	preset({
		id: "flip-x",
		label: "Flip X",
		state: { "transform.scaleX": -1, opacity: 0 },
		keywords: ["flip"],
	}),
	preset({
		id: "flip-y",
		label: "Flip Y",
		state: { "transform.scaleY": -1, opacity: 0 },
		keywords: ["flip"],
	}),
	preset({
		id: "spin-left",
		label: "Spin Left",
		state: { "transform.rotate": -180, opacity: 0 },
		keywords: ["rotate"],
	}),
	preset({
		id: "spin-right",
		label: "Spin Right",
		state: { "transform.rotate": 180, opacity: 0 },
		keywords: ["rotate"],
	}),
	preset({
		id: "tilt-left",
		label: "Tilt Left",
		state: { "transform.rotate": -25, opacity: 0 },
		keywords: ["rotate"],
	}),
	preset({
		id: "tilt-right",
		label: "Tilt Right",
		state: { "transform.rotate": 25, opacity: 0 },
		keywords: ["rotate"],
	}),
	preset({
		id: "rise-soft",
		label: "Rise Soft",
		state: { "transform.positionY": 45, opacity: 0 },
		keywords: ["soft"],
	}),
	preset({
		id: "drop-soft",
		label: "Drop Soft",
		state: { "transform.positionY": -45, opacity: 0 },
		keywords: ["soft"],
	}),
	preset({
		id: "drift-left",
		label: "Drift Left",
		state: { "transform.positionX": 45, opacity: 0 },
		keywords: ["soft"],
	}),
	preset({
		id: "drift-right",
		label: "Drift Right",
		state: { "transform.positionX": -45, opacity: 0 },
		keywords: ["soft"],
	}),
	preset({
		id: "corner-tl",
		label: "Corner Top Left",
		state: {
			"transform.positionX": -160,
			"transform.positionY": -90,
			opacity: 0,
		},
		keywords: ["corner"],
	}),
	preset({
		id: "corner-tr",
		label: "Corner Top Right",
		state: {
			"transform.positionX": 160,
			"transform.positionY": -90,
			opacity: 0,
		},
		keywords: ["corner"],
	}),
	preset({
		id: "corner-bl",
		label: "Corner Bottom Left",
		state: {
			"transform.positionX": -160,
			"transform.positionY": 90,
			opacity: 0,
		},
		keywords: ["corner"],
	}),
	preset({
		id: "corner-br",
		label: "Corner Bottom Right",
		state: {
			"transform.positionX": 160,
			"transform.positionY": 90,
			opacity: 0,
		},
		keywords: ["corner"],
	}),
	preset({
		id: "squash",
		label: "Squash",
		state: { "transform.scaleX": 1.6, "transform.scaleY": 0.25, opacity: 0 },
		keywords: ["scale"],
	}),
	preset({
		id: "stretch",
		label: "Stretch",
		state: { "transform.scaleX": 0.35, "transform.scaleY": 1.6, opacity: 0 },
		keywords: ["scale"],
	}),
	preset({
		id: "wipe-left",
		label: "Wipe Left",
		state: { "transform.scaleX": 0.05, "transform.positionX": -80, opacity: 0 },
		keywords: ["wipe"],
	}),
	preset({
		id: "wipe-right",
		label: "Wipe Right",
		state: { "transform.scaleX": 0.05, "transform.positionX": 80, opacity: 0 },
		keywords: ["wipe"],
	}),
	preset({
		id: "wipe-up",
		label: "Wipe Up",
		state: { "transform.scaleY": 0.05, "transform.positionY": -60, opacity: 0 },
		keywords: ["wipe"],
	}),
	preset({
		id: "wipe-down",
		label: "Wipe Down",
		state: { "transform.scaleY": 0.05, "transform.positionY": 60, opacity: 0 },
		keywords: ["wipe"],
	}),
	preset({
		id: "float-spin",
		label: "Float Spin",
		state: { "transform.positionY": 80, "transform.rotate": -90, opacity: 0 },
		keywords: ["rotate"],
	}),
	preset({
		id: "snap-spin",
		label: "Snap Spin",
		state: {
			"transform.scaleX": 0.4,
			"transform.scaleY": 0.4,
			"transform.rotate": 90,
			opacity: 0,
		},
		keywords: ["rotate"],
	}),
	preset({
		id: "glitch",
		label: "Glitch",
		state: {},
		keywords: ["glitch", "strobe"],
		recipe: {
			opacity: [
				{ at: 0, value: 0 },
				{ at: 0.08, value: 1 },
				{ at: 0.16, value: 0.15 },
				{ at: 0.24, value: 1 },
				{ at: 0.36, value: 0.45 },
				{ at: 0.48, value: 1 },
				{ at: 1, value: 1 },
			],
			"transform.positionX": [
				{ at: 0, value: -70 },
				{ at: 0.12, value: 55 },
				{ at: 0.2, value: -35 },
				{ at: 0.34, value: 22 },
				{ at: 0.52, value: -8 },
				{ at: 1, value: 0 },
			],
			"transform.positionY": [
				{ at: 0, value: 14 },
				{ at: 0.18, value: -10 },
				{ at: 0.34, value: 8 },
				{ at: 1, value: 0 },
			],
		},
	}),
	premiumPreset({
		id: "shatter",
		label: "Shatter · ניפוץ",
		keywords: ["explode", "broken glass", "fragments", "text"],
		recipe: {
			"transition.shatter": keys(
				[0, 1],
				[0.18, 0.72],
				[0.5, 0.2],
				[1, 0],
			),
			opacity: keys([0, 0], [0.22, 0.72], [0.55, 1], [1, 1]),
		},
	}),
	preset({
		id: "elastic-drop",
		label: "Elastic Drop",
		state: {},
		keywords: ["bounce"],
		recipe: {
			opacity: [
				{ at: 0, value: 0 },
				{ at: 0.18, value: 1 },
				{ at: 1, value: 1 },
			],
			"transform.positionY": [
				{ at: 0, value: -220 },
				{ at: 0.38, value: 28 },
				{ at: 0.58, value: -16 },
				{ at: 0.78, value: 7 },
				{ at: 1, value: 0 },
			],
			"transform.scaleY": [
				{ at: 0, value: 1.35 },
				{ at: 0.38, value: 0.82 },
				{ at: 0.58, value: 1.08 },
				{ at: 1, value: 1 },
			],
		},
	}),
	preset({
		id: "rubber-band",
		label: "Rubber Band",
		state: {},
		keywords: ["bounce"],
		recipe: {
			opacity: [
				{ at: 0, value: 0 },
				{ at: 0.1, value: 1 },
				{ at: 1, value: 1 },
			],
			"transform.scaleX": [
				{ at: 0, value: 0.2 },
				{ at: 0.28, value: 1.35 },
				{ at: 0.45, value: 0.75 },
				{ at: 0.65, value: 1.12 },
				{ at: 1, value: 1 },
			],
			"transform.scaleY": [
				{ at: 0, value: 1.8 },
				{ at: 0.28, value: 0.72 },
				{ at: 0.45, value: 1.25 },
				{ at: 0.65, value: 0.92 },
				{ at: 1, value: 1 },
			],
		},
	}),
	preset({
		id: "portal",
		label: "Portal",
		state: {},
		keywords: ["spin", "scale"],
		recipe: {
			opacity: [
				{ at: 0, value: 0 },
				{ at: 0.26, value: 1 },
				{ at: 1, value: 1 },
			],
			"transform.scaleX": [
				{ at: 0, value: 0.05 },
				{ at: 0.42, value: 1.22 },
				{ at: 1, value: 1 },
			],
			"transform.scaleY": [
				{ at: 0, value: 1.9 },
				{ at: 0.42, value: 0.82 },
				{ at: 1, value: 1 },
			],
			"transform.rotate": [
				{ at: 0, value: 360 },
				{ at: 1, value: 0 },
			],
		},
	}),
	...PREMIUM_TRANSITION_PRESETS,
];

export function getTransitionPreset({ id }: { id: string }): TransitionPreset {
	return (
		TRANSITION_PRESETS.find((transition) => transition.id === id) ??
		TRANSITION_PRESETS[0]
	);
}
