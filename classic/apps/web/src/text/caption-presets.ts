import type { TextCaptionRevealMode, TextWordStyle } from "@/timeline";

export interface CaptionWordAnimation {
	id: string;
	name: string;
	revealMode: TextCaptionRevealMode;
	idleStyle: TextWordStyle;
	activeStyle: TextWordStyle;
	spokenStyle?: TextWordStyle;
	useAccentOnActive?: boolean;
	useAccentOnSpoken?: boolean;
}

export const CAPTION_ACCENT_COLORS = [
	{ value: "#c8ff4d", label: "Lime" },
	{ value: "#54e7ff", label: "Cyan" },
	{ value: "#ff7867", label: "Coral" },
	{ value: "#ffd84d", label: "Gold" },
	{ value: "#ff68c7", label: "Pink" },
	{ value: "#83ffc6", label: "Mint" },
	{ value: "#b894ff", label: "Violet" },
	{ value: "#d9f6ff", label: "Ice" },
	{ value: "#ff9f2e", label: "Fire" },
	{ value: "#ffffff", label: "White" },
] as const;

const families = [
	{
		id: "kinetic-slam",
		name: "Kinetic Slam",
		revealMode: "emphasize-spoken",
		idle: { opacity: 0.48, scale: 0.92, offsetY: 10, blur: 1 },
		active: { opacity: 1, scale: 1.34, offsetY: -14, fontWeight: "bold" },
		spoken: { opacity: 0.74, scale: 1 },
		accent: true,
	},
	{
		id: "magnetic-build",
		name: "Magnetic Build",
		revealMode: "growing-row",
		idle: { opacity: 0, scale: 0.7, offsetX: 34, blur: 10 },
		active: { opacity: 1, scale: 1.18, offsetX: 0, blur: 0, fontWeight: "bold" },
		spoken: { opacity: 1, scale: 1 },
		accent: true,
	},
	{
		id: "neon-lock",
		name: "Neon Lock",
		revealMode: "emphasize-spoken-keep",
		idle: { opacity: 0.38, scale: 0.96, blur: 2 },
		active: { opacity: 1, scale: 1.22, offsetY: -8, fontWeight: "bold" },
		spoken: { opacity: 1, scale: 1.08, fontWeight: "bold" },
		accent: true,
		keepAccent: true,
	},
	{
		id: "typewriter-flare",
		name: "Typewriter Flare",
		revealMode: "spoken-word",
		idle: { opacity: 0, scale: 0.86, letterSpacing: 10, blur: 3 },
		active: { opacity: 1, scale: 1.16, letterSpacing: 0, fontWeight: "bold" },
		accent: true,
	},
	{
		id: "wave-pulse",
		name: "Wave Pulse",
		revealMode: "emphasize-spoken",
		idle: { opacity: 0.58, offsetY: 8, scale: 0.96 },
		active: { opacity: 1, offsetY: -18, scale: 1.24, fontStyle: "italic" },
		spoken: { opacity: 0.82, offsetY: 0 },
		accent: true,
	},
	{
		id: "glass-focus",
		name: "Glass Focus",
		revealMode: "emphasize-spoken",
		idle: { opacity: 0.5, blur: 5, scale: 1.04 },
		active: { opacity: 1, blur: 0, scale: 1.18, fontWeight: "bold" },
		spoken: { opacity: 0.72, blur: 1 },
		accent: true,
	},
	{
		id: "elastic-pop",
		name: "Elastic Pop",
		revealMode: "emphasize-spoken",
		idle: { opacity: 0.54, scale: 0.82, offsetY: 6 },
		active: { opacity: 1, scale: 1.42, offsetY: -10, rotate: -2 },
		spoken: { opacity: 0.78, scale: 1.02 },
		accent: true,
	},
	{
		id: "marker-sweep",
		name: "Marker Sweep",
		revealMode: "emphasize-spoken-keep",
		idle: { opacity: 0.46 },
		active: { opacity: 1, scale: 1.16, fontWeight: "bold", textDecoration: "underline" },
		spoken: { opacity: 1, scale: 1.04, textDecoration: "underline" },
		accent: true,
		keepAccent: true,
	},
	{
		id: "cinema-breath",
		name: "Cinema Breath",
		revealMode: "row",
		idle: { opacity: 1, scale: 1 },
		active: { opacity: 1, scale: 1 },
		spoken: { opacity: 1 },
	},
	{
		id: "focus-tunnel",
		name: "Focus Tunnel",
		revealMode: "emphasize-spoken",
		idle: { opacity: 0.34, scale: 0.82, blur: 6 },
		active: { opacity: 1, scale: 1.32, blur: 0, fontWeight: "bold" },
		spoken: { opacity: 0.62, scale: 0.96, blur: 1 },
		accent: true,
	},
	{
		id: "bounce-cascade",
		name: "Bounce Cascade",
		revealMode: "growing-row",
		idle: { opacity: 0, scale: 0.5, offsetY: 26, blur: 7 },
		active: { opacity: 1, scale: 1.28, offsetY: -8, blur: 0 },
		spoken: { opacity: 1, scale: 1.03 },
		accent: true,
	},
	{
		id: "clean-spotlight",
		name: "Clean Spotlight",
		revealMode: "emphasize-spoken",
		idle: { opacity: 0.42 },
		active: { opacity: 1, scale: 1.2, fontWeight: "bold" },
		spoken: { opacity: 0.7 },
		accent: true,
	},
	{
		id: "ghost-trail",
		name: "Ghost Trail",
		revealMode: "emphasize-spoken-keep",
		idle: { opacity: 0.28, blur: 4, offsetX: -12 },
		active: { opacity: 1, blur: 0, offsetX: 0, scale: 1.24 },
		spoken: { opacity: 0.9, blur: 0, offsetX: 0 },
		accent: true,
	},
	{
		id: "impact-shift",
		name: "Impact Shift",
		revealMode: "emphasize-spoken",
		idle: { opacity: 0.56, offsetX: -8, scale: 0.94 },
		active: { opacity: 1, offsetX: 0, scale: 1.3, rotate: 2, fontWeight: "bold" },
		spoken: { opacity: 0.76, offsetX: 0 },
		accent: true,
	},
	{
		id: "soft-reveal",
		name: "Soft Reveal",
		revealMode: "growing-row",
		idle: { opacity: 0, blur: 12, scale: 1.12 },
		active: { opacity: 1, blur: 0, scale: 1.08 },
		spoken: { opacity: 1 },
		accent: true,
	},
	{
		id: "lyric-rise",
		name: "Lyric Rise",
		revealMode: "emphasize-spoken",
		idle: { opacity: 0.5, offsetY: 12, fontStyle: "italic" },
		active: { opacity: 1, offsetY: -12, scale: 1.2, fontStyle: "italic" },
		spoken: { opacity: 0.82, offsetY: 0 },
		accent: true,
	},
	{
		id: "stamp-lock",
		name: "Stamp Lock",
		revealMode: "emphasize-spoken-keep",
		idle: { opacity: 0.36, scale: 0.92, rotate: -1 },
		active: { opacity: 1, scale: 1.34, rotate: 0, fontWeight: "bold" },
		spoken: { opacity: 1, scale: 1.1, fontWeight: "bold" },
		accent: true,
		keepAccent: true,
	},
	{
		id: "single-word-hit",
		name: "Single Word Hit",
		revealMode: "spoken-word",
		idle: { opacity: 0, scale: 0.4, blur: 10, rotate: -6 },
		active: { opacity: 1, scale: 1.34, blur: 0, rotate: 0, fontWeight: "bold" },
		accent: true,
	},
	{
		id: "minimal-reader",
		name: "Minimal Reader",
		revealMode: "emphasize-spoken",
		idle: { opacity: 0.72 },
		active: { opacity: 1, scale: 1.08, fontWeight: "bold" },
		spoken: { opacity: 0.86 },
		accent: true,
	},
	{
		id: "rush-forward",
		name: "Rush Forward",
		revealMode: "growing-row",
		idle: { opacity: 0, offsetX: -42, scale: 0.88, blur: 8 },
		active: { opacity: 1, offsetX: 0, scale: 1.18, blur: 0 },
		spoken: { opacity: 1, scale: 1 },
		accent: true,
	},
	{
		id: "hypnotic-orbit",
		name: "Hypnotic Orbit",
		revealMode: "emphasize-spoken",
		idle: { opacity: 0.36, scale: 0.88, rotate: -5, blur: 3 },
		active: { opacity: 1, scale: 1.28, rotate: 5, blur: 0, shadowBlur: 22 },
		spoken: { opacity: 0.78, scale: 1, rotate: 0, shadowBlur: 8 },
		accent: true,
	},
	{
		id: "glow-zoom-dissolve",
		name: "Glow Zoom Dissolve",
		revealMode: "spoken-word-keep",
		idle: { opacity: 0, scale: 1.45, blur: 16, shadowBlur: 0 },
		active: { opacity: 1, scale: 1.18, blur: 0, shadowBlur: 28, fontWeight: "bold" },
		spoken: { opacity: 0.92, scale: 1, blur: 0, shadowBlur: 10 },
		accent: true,
		keepAccent: true,
	},
	{
		id: "letter-laser",
		name: "Letter Laser",
		revealMode: "spoken-word-keep",
		idle: { opacity: 0, letterSpacing: 12, blur: 6, characterReveal: true },
		active: { opacity: 1, letterSpacing: 1, blur: 0, characterReveal: true, shadowBlur: 18 },
		spoken: { opacity: 1, letterSpacing: 0, characterReveal: false },
		accent: true,
		keepAccent: true,
	},
	{
		id: "mist-to-crystal",
		name: "Mist To Crystal",
		revealMode: "growing-row",
		idle: { opacity: 0, scale: 1.2, blur: 18, offsetY: 10 },
		active: { opacity: 1, scale: 1.12, blur: 0, offsetY: -4, shadowBlur: 14 },
		spoken: { opacity: 1, scale: 1, blur: 0 },
		accent: true,
	},
	{
		id: "pulse-halo",
		name: "Pulse Halo",
		revealMode: "emphasize-spoken",
		idle: { opacity: 0.52, scale: 0.96, shadowBlur: 0 },
		active: { opacity: 1, scale: 1.26, shadowBlur: 30, fontWeight: "bold" },
		spoken: { opacity: 0.82, scale: 1.02, shadowBlur: 7 },
		accent: true,
	},
	{
		id: "liquid-bloom",
		name: "Liquid Bloom",
		revealMode: "spoken-word-keep",
		idle: { opacity: 0, scale: 0.62, blur: 14, offsetY: 16 },
		active: { opacity: 1, scale: 1.32, blur: 0, offsetY: -6, fontStyle: "italic" },
		spoken: { opacity: 1, scale: 1.04, blur: 0 },
		accent: true,
		keepAccent: true,
	},
	{
		id: "afterimage-pop",
		name: "Afterimage Pop",
		revealMode: "emphasize-spoken-keep",
		idle: { opacity: 0.32, offsetX: -18, blur: 5 },
		active: { opacity: 1, offsetX: 0, scale: 1.3, shadowBlur: 18 },
		spoken: { opacity: 0.95, offsetX: 0, scale: 1.06, shadowBlur: 5 },
		accent: true,
		keepAccent: true,
	},
	{
		id: "whisper-type",
		name: "Whisper Type",
		revealMode: "spoken-word-keep",
		idle: { opacity: 0, characterReveal: true, blur: 4, letterSpacing: 8 },
		active: { opacity: 1, characterReveal: true, blur: 0, letterSpacing: 2 },
		spoken: { opacity: 0.88, characterReveal: false, letterSpacing: 0 },
		accent: true,
	},
	{
		id: "supernova-hit",
		name: "Supernova Hit",
		revealMode: "spoken-word",
		idle: { opacity: 0, scale: 2.2, blur: 20, rotate: -8 },
		active: { opacity: 1, scale: 1.38, blur: 0, rotate: 0, shadowBlur: 38, fontWeight: "bold" },
		accent: true,
	},
	{
		id: "breathing-row",
		name: "Breathing Row",
		revealMode: "row",
		idle: { opacity: 1, scale: 1, blur: 0 },
		active: { opacity: 1, scale: 1.04, blur: 0, shadowBlur: 6 },
		spoken: { opacity: 1 },
		accent: false,
	},
	{
		id: "ribbon-rise",
		name: "Ribbon Rise",
		revealMode: "growing-row",
		idle: { opacity: 0, offsetY: 34, rotate: 4, blur: 9 },
		active: { opacity: 1, offsetY: -10, rotate: 0, scale: 1.22 },
		spoken: { opacity: 1, offsetY: 0, scale: 1 },
		accent: true,
	},
	{
		id: "dream-marker",
		name: "Dream Marker",
		revealMode: "emphasize-spoken-keep",
		idle: { opacity: 0.42, blur: 2 },
		active: { opacity: 1, scale: 1.16, textDecoration: "underline", shadowBlur: 20 },
		spoken: { opacity: 1, scale: 1.03, textDecoration: "underline", shadowBlur: 8 },
		accent: true,
		keepAccent: true,
	},
] as const;

const variants = [
	{ id: "1", name: "Core", idle: {}, active: {}, spoken: {} },
	{ id: "2", name: "Heavy", idle: { opacity: -0.08 }, active: { scale: 0.12, offsetY: -4, fontWeight: "bold" }, spoken: { scale: 0.04 } },
	{ id: "3", name: "Blur Motion", idle: { blur: 3, offsetY: 4 }, active: { blur: 0, scale: 0.06 }, spoken: { blur: 1 } },
	{ id: "4", name: "Wide Snap", idle: { letterSpacing: 3 }, active: { letterSpacing: -1, scale: 0.08, offsetX: 3 }, spoken: { letterSpacing: 0 } },
	{ id: "5", name: "Tilted", idle: { rotate: -3 }, active: { rotate: 3, scale: 0.08 }, spoken: { rotate: 0 } },
	{ id: "6", name: "Glow", idle: { shadowBlur: 0 }, active: { shadowBlur: 18, scale: 0.05 }, spoken: { shadowBlur: 7 } },
	{ id: "7", name: "Micro Type", idle: { characterReveal: true, letterSpacing: 2 }, active: { characterReveal: true, shadowBlur: 8 }, spoken: { characterReveal: false } },
	{ id: "8", name: "Dream Blur", idle: { blur: 8, scale: 0.08 }, active: { blur: 0, scale: 0.1, shadowBlur: 14 }, spoken: { blur: 0 } },
] as const;

const NONE_CAPTION_WORD_ANIMATION: CaptionWordAnimation = {
	id: "none",
	name: "None",
	revealMode: "row",
	idleStyle: { opacity: 1, scale: 1 },
	activeStyle: { opacity: 1, scale: 1 },
	spokenStyle: { opacity: 1, scale: 1 },
	useAccentOnActive: false,
	useAccentOnSpoken: false,
};

function mergeStyle(
	{
		base,
		variant,
	}: {
		base: TextWordStyle;
		variant: TextWordStyle;
	},
): TextWordStyle {
	return {
		...base,
		...Object.fromEntries(
			Object.entries(variant).map(([key, value]) => [
				key,
				typeof value === "number" && typeof base[key as keyof TextWordStyle] === "number"
					? (base[key as keyof TextWordStyle] as number) + value
					: value,
			]),
		),
	};
}

export const CAPTION_WORD_ANIMATIONS: CaptionWordAnimation[] = [
	NONE_CAPTION_WORD_ANIMATION,
	...families.flatMap((family) =>
		variants.map((variant) => ({
			id: `${family.id}-${variant.id}`,
			name: `${family.name} ${variant.name}`,
			revealMode: family.revealMode as TextCaptionRevealMode,
			idleStyle: mergeStyle({ base: family.idle, variant: variant.idle }),
			activeStyle: mergeStyle({ base: family.active, variant: variant.active }),
			spokenStyle:
				"spoken" in family
					? mergeStyle({ base: family.spoken, variant: variant.spoken })
					: undefined,
			useAccentOnActive: "accent" in family ? family.accent : false,
			useAccentOnSpoken: "keepAccent" in family ? family.keepAccent : false,
		})),
	),
];

export function getCaptionWordAnimation({
	wordAnimationId,
}: {
	wordAnimationId: string | undefined;
}): CaptionWordAnimation {
	return (
		CAPTION_WORD_ANIMATIONS.find((animation) => animation.id === wordAnimationId) ??
		CAPTION_WORD_ANIMATIONS[0]
	);
}
