import { CUSTOM_AI_EFFECT_TYPE } from "@/effects/custom-ai-effect";
import type { ParamValues } from "@/params";

export interface OverlayEffectPreset {
	id: string;
	name: string;
	use: string;
	params: ParamValues;
}

function overlay({
	id,
	name,
	use,
	blur = 0,
	intensity = 60,
}: {
	id: string;
	name: string;
	use: string;
	blur?: number;
	intensity?: number;
}): OverlayEffectPreset {
	return {
		id,
		name,
		use,
		params: {
			label: name,
			kind: "overlay-effect",
			requestedType: name,
			intent: use,
			specJson: JSON.stringify({
				intensity,
				blur,
				blend: inferBlendMode(name),
				affects: "tracks-below",
			}),
		},
	};
}

export const OVERLAY_EFFECT_TYPE = CUSTOM_AI_EFFECT_TYPE;

export const OVERLAY_EFFECT_PRESETS: OverlayEffectPreset[] = [
	overlay({
		id: "glow",
		name: "Glow",
		use: "Dreamy highlights, faces, products",
		blur: 10,
	}),
	overlay({
		id: "dreamy-glow",
		name: "Dreamy Glow",
		use: "Soft aesthetic edits",
		blur: 18,
	}),
	overlay({
		id: "edge-glow",
		name: "Edge Glow",
		use: "Outlines around subject",
		blur: 6,
	}),
	overlay({
		id: "neon-glow",
		name: "Neon Glow",
		use: "Music, gaming, nightlife",
		blur: 12,
	}),
	overlay({
		id: "aura-glow",
		name: "Aura Glow",
		use: "Spiritual / emotional edits",
		blur: 14,
	}),
	overlay({
		id: "golden-glow",
		name: "Golden Glow",
		use: "Sunset and warm cinematic looks",
		blur: 9,
	}),
	overlay({
		id: "light-leak",
		name: "Light Leak",
		use: "Film-style transitions",
	}),
	overlay({
		id: "lens-flare",
		name: "Lens Flare",
		use: "Sunlight / dramatic shine",
	}),
	overlay({
		id: "flash",
		name: "Flash",
		use: "Beat drops and cuts",
		intensity: 82,
	}),
	overlay({
		id: "sparkle",
		name: "Sparkle",
		use: "Beauty, fashion, product shots",
	}),
	overlay({ id: "shimmer", name: "Shimmer", use: "Luxury / clean edits" }),
	overlay({
		id: "retro-spots",
		name: "Retro Spots",
		use: "Vintage texture overlay",
	}),
	overlay({ id: "old-footage", name: "Old Footage", use: "Aged film look" }),
	overlay({ id: "vhs", name: "VHS", use: "80s/90s camcorder style" }),
	overlay({ id: "film-grain", name: "Film Grain", use: "Cinematic texture" }),
	overlay({
		id: "lofi-dust",
		name: "Dust / Lofi Dust",
		use: "Old-film dirt and scratches",
	}),
	overlay({
		id: "scratches",
		name: "Scratches",
		use: "Vintage damaged-film look",
	}),
	overlay({ id: "sepia", name: "Sepia", use: "Classic old-photo tone" }),
	overlay({
		id: "retro-film",
		name: "Retro Film",
		use: "Warm nostalgic clips",
	}),
	overlay({ id: "8mm-film", name: "8mm Film", use: "Handheld retro footage" }),
	overlay({ id: "glitch", name: "Glitch", use: "Tech, edits, beat sync" }),
	overlay({
		id: "rgb-split",
		name: "RGB Split",
		use: "Color separation / impact",
	}),
	overlay({
		id: "chromatic-aberration",
		name: "Chromatic Aberration",
		use: "Edgy cinematic distortion",
	}),
	overlay({ id: "scan-lines", name: "Scan Lines", use: "VHS / monitor look" }),
	overlay({
		id: "digital-noise",
		name: "Digital Noise",
		use: "Cyber / rough texture",
	}),
	overlay({
		id: "pixelate",
		name: "Pixelate",
		use: "Censoring or gaming style",
	}),
	overlay({ id: "blur", name: "Blur", use: "Smooth transitions", blur: 15 }),
	overlay({
		id: "motion-blur",
		name: "Motion Blur",
		use: "Fast movement, velocity edits",
		blur: 18,
	}),
	overlay({
		id: "zoom-blur",
		name: "Zoom Blur",
		use: "Dramatic push-in moments",
		blur: 20,
	}),
	overlay({
		id: "radial-blur",
		name: "Radial Blur",
		use: "Spin / impact edits",
		blur: 16,
	}),
	overlay({
		id: "directional-blur",
		name: "Directional Blur",
		use: "Speed and movement",
		blur: 18,
	}),
	overlay({
		id: "background-blur",
		name: "Background Blur",
		use: "Portrait / subject focus",
		blur: 14,
	}),
	overlay({
		id: "soft-focus",
		name: "Soft Focus",
		use: "Romantic or dreamy scenes",
		blur: 10,
	}),
	overlay({
		id: "bokeh",
		name: "Bokeh",
		use: "Lights, night, romance",
		blur: 8,
	}),
	overlay({
		id: "ultra-sharpen",
		name: "Ultra Sharpen",
		use: "Make clips look crisper",
	}),
	overlay({
		id: "ai-ultra-sharpen",
		name: "AI Ultra Sharpen",
		use: "Fix soft or low-res clips",
	}),
	overlay({ id: "hdr", name: "HDR", use: "Strong contrast and detail" }),
	overlay({
		id: "4k-filter",
		name: "4K Filter",
		use: "Clean high quality look",
	}),
	overlay({ id: "clarity", name: "Clarity", use: "Sharper midtones" }),
	overlay({
		id: "detail-enhance",
		name: "Detail Enhance",
		use: "Product, food, travel shots",
	}),
	overlay({
		id: "motion-trail",
		name: "Motion Trail",
		use: "Subject leaves trails",
	}),
	overlay({
		id: "echo-afterimage",
		name: "Echo / Afterimage",
		use: "Repeated ghost movement",
	}),
	overlay({ id: "strobe", name: "Strobe", use: "Fast flashing beat edits" }),
	overlay({ id: "flicker", name: "Flicker", use: "Vintage or horror tension" }),
	overlay({
		id: "camera-shake",
		name: "Camera Shake",
		use: "Action and impact",
	}),
	overlay({ id: "beat-shake", name: "Beat Shake", use: "Music drops" }),
	overlay({ id: "pulse", name: "Pulse", use: "Heartbeat / bass effect" }),
	overlay({
		id: "3d-zoom",
		name: "3D Zoom",
		use: "Photo-to-video depth effect",
	}),
	overlay({
		id: "3d-spin",
		name: "3D Spin",
		use: "Dynamic object/photo movement",
	}),
	overlay({
		id: "freeze-frame",
		name: "Freeze Frame",
		use: "Highlight a moment",
	}),
	overlay({ id: "mirror", name: "Mirror", use: "Symmetry / fashion edits" }),
	overlay({
		id: "kaleidoscope",
		name: "Kaleidoscope",
		use: "Psychedelic music edits",
	}),
	overlay({ id: "fisheye", name: "Fisheye", use: "Skate, vlog, street style" }),
	overlay({
		id: "magnifier",
		name: "Magnifier",
		use: "Focus on small details",
	}),
	overlay({
		id: "wave-ripple",
		name: "Wave / Ripple",
		use: "Water or dream distortion",
	}),
	overlay({ id: "fire", name: "Fire", use: "Gaming, hype, sports" }),
	overlay({ id: "smoke", name: "Smoke", use: "Dark cinematic atmosphere" }),
	overlay({
		id: "lightning",
		name: "Lightning",
		use: "Power / dramatic impact",
	}),
	overlay({ id: "rain", name: "Rain", use: "Sad, cinematic, moody clips" }),
	overlay({ id: "snow", name: "Snow", use: "Winter, fantasy, soft edits" }),
];

function inferBlendMode(name: string) {
	const normalized = name.toLowerCase();
	if (
		normalized.includes("glow") ||
		normalized.includes("flare") ||
		normalized.includes("sparkle")
	) {
		return "screen";
	}
	if (
		normalized.includes("grain") ||
		normalized.includes("dust") ||
		normalized.includes("scratches")
	) {
		return "overlay";
	}
	return "normal";
}
