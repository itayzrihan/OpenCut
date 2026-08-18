import { UI_ELEMENT_GRAPHIC_ID } from "@/graphics/definitions/ui-element";
import type { ParamValues } from "@/params";

export interface UiElementPreset {
	id: string;
	name: string;
	description: string;
	category: string;
	keywords: string[];
	whenToUse: string;
	defaultDurationSeconds: number;
	params: ParamValues;
	bundle?: UiElementBundle;
}

export interface UiElementBundleGraphicClip {
	name: string;
	definitionId: string;
	startOffsetSeconds: number;
	durationSeconds: number;
	params: ParamValues;
}

export interface UiElementBundleAudioClip {
	name: string;
	libraryAssetId: string;
	startOffsetSeconds: number;
	durationSeconds: number;
	sourceDurationSeconds: number;
	trimStartSeconds: number;
	trimEndSeconds: number;
	params: ParamValues;
}

export interface UiElementBundle {
	graphics: UiElementBundleGraphicClip[];
	audio: UiElementBundleAudioClip[];
}

export const COLOR_REVEAL_WHOOSH_ASSET_ID =
	"19f29ed9-a604-4933-ae8c-e494b6cee47f";
export const CANCELLATION_CHECKLIST_GLITCH_ASSET_ID =
	"fedd7133-5b46-406a-8085-f733ea28b367";
export const GOAL_SLIDER_IN_SFX_ASSET_ID =
	"80930d56-fba9-4869-b9b7-b94dc804497d";
export const GOAL_SLIDER_OUT_SFX_ASSET_ID =
	"748324d3-6e31-4bff-92a2-843ea2e20127";
export const COUNTER_TYPING_SFX_ASSET_ID =
	"d7c18d8a-10cb-47d4-af34-6a1bea4300d3";

const GOAL_SLIDER_PARAMS: ParamValues = {
	template: "goal-slider",
	label: "$10,000",
	secondary: "$7,200",
	items: "Research\nDesign\nEdit\nPublish",
	itemCount: 4,
	accent: "#4EA1FF",
	background: "#050505",
	foreground: "#FFFFFF",
	progress: 72,
	checked: 2,
	count: 3,
	intensity: 60,
	batteryMode: "drain",
	screenMode: "auto",
	animationIn: "progress-meter-sweep",
	animationInEnd: 30,
	animationOut: "progress-complete-flash",
	animationOutStart: 86,
	animationStrength: 88,
	eventAt: 68,
};

const RTL_CANCELLATION_CHECKLIST_PARAMS: ParamValues = {
	template: "checkbox-list",
	label: "שלוש דרכים לבטל הצלחה",
	secondary: "",
	items: "יש לו כסף\nקנו אותו\nעשו לו",
	itemCount: 3,
	itemsFontFamily: "Inter",
	textDirection: "rtl",
	textRevealMode: "determined-by-preset",
	textTransitionIn: "blur-zoom",
	animationIn: "list-one-by-one",
	animationInEnd: 30,
	animationOut: "list-blur-zoom-fade",
	animationOutStart: 91.64,
	animationStrength: 72,
	eventAt: 79.38,
	eventTransitionDuration: 6,
	eventBackgroundEnabled: true,
	eventBackground: "#D92D20",
	itemStartPoints: "0,26.19,36.68",
	itemEndPoints: "100,100,100",
	listRevealMode: "sequential",
	listBaseOpacity: 0,
	listRiseDistance: 36,
	listItemInDuration: 6,
	listItemOutDuration: 0,
	listBarFitToText: false,
	listBarWidth: 54,
	listBarHeight: 8,
	listBarGap: 2.5,
	listBarRadius: 14,
	listBackgroundBlur: 0,
	listTextAlign: "right",
	listTextSize: 28,
	accent: "#D8DBDE",
	background: "#24272A",
	foreground: "#FFFFFF",
	checked: 3,
	"transform.positionY": -476.68513939807315,
};

const COLOR_REVEAL_MASK_HTML = `<style>
.hf-root{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.mono{position:absolute;inset:0;background:#808080;clip-path:inset(0 0 0 20%);animation:monoReveal 3s cubic-bezier(.65,0,.35,1) both}
@keyframes monoReveal{
  0%,12%{clip-path:inset(0 0 0 20%)}
  85%{clip-path:inset(0 0 0 100%)}
  100%{clip-path:inset(0 0 0 100%)}
}
</style>
<div class="hf-root"><div class="mono"></div></div>`;

const COLOR_REVEAL_DIVIDER_HTML = `<style>
.hf-root{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.line{position:absolute;top:0;bottom:0;left:20%;width:5px;margin-left:-2.5px;background:#fff;box-shadow:0 0 7px rgba(255,255,255,.95),0 0 18px rgba(255,255,255,.62),0 0 32px rgba(255,255,255,.28);animation:dividerMove 3s cubic-bezier(.65,0,.35,1) both}
@keyframes dividerMove{
  0%,12%{left:20%;opacity:1}
  85%{left:100%;opacity:1}
  92%,100%{left:100%;opacity:0}
}
</style>
<div class="hf-root"><div class="line"></div></div>`;

function preset({
	id,
	name,
	description,
	template,
	label,
	secondary = "Details",
	items,
	accent = "#00e5ff",
	background = "#111827",
	foreground = "#ffffff",
	progress = 64,
	checked = 2,
	count = 3,
	intensity = 60,
	batteryMode = "drain",
	screenMode = "auto",
	category = "utility",
	keywords = [],
	whenToUse = "Use when the spoken beat needs a compact interface proof.",
	defaultDurationSeconds = 2.5,
	animationIn = "auto",
	animationInEnd = 18,
	animationOut = "auto",
	animationOutStart = 82,
	animationStrength = 100,
	eventAt = 55,
	bundleAudio,
}: {
	id: string;
	name: string;
	description: string;
	template: string;
	label: string;
	secondary?: string;
	items?: string;
	accent?: string;
	background?: string;
	foreground?: string;
	progress?: number;
	checked?: number;
	count?: number;
	intensity?: number;
	batteryMode?: string;
	screenMode?: string;
	category?: string;
	keywords?: string[];
	whenToUse?: string;
	defaultDurationSeconds?: number;
	animationIn?: string;
	animationInEnd?: number;
	animationOut?: string;
	animationOutStart?: number;
	animationStrength?: number;
	eventAt?: number;
	bundleAudio?: UiElementBundleAudioClip[];
}): UiElementPreset {
	const params: ParamValues = {
		template,
		label,
		secondary,
		items: items ?? "Research\nDesign\nEdit\nPublish",
		itemCount: (items ?? "Research\nDesign\nEdit\nPublish")
			.split("\n")
			.filter((item) => item.trim().length > 0).length,
		accent,
		background,
		foreground,
		progress,
		checked,
		count,
		intensity,
		batteryMode,
		screenMode,
		animationIn,
		animationInEnd,
		animationOut,
		animationOutStart,
		animationStrength,
		eventAt,
	};
	return {
		id,
		name,
		description,
		category,
		keywords,
		whenToUse,
		defaultDurationSeconds,
		params,
		bundle: bundleAudio
			? {
					graphics: [
						{
							name,
							definitionId: UI_ELEMENT_DEFINITION_ID,
							startOffsetSeconds: 0,
							durationSeconds: defaultDurationSeconds,
							params,
						},
					],
					audio: bundleAudio,
				}
			: undefined,
	};
}

export const UI_ELEMENT_DEFINITION_ID = UI_ELEMENT_GRAPHIC_ID;

export const UI_ELEMENT_PRESETS: UiElementPreset[] = [
	{
		id: "color-reveal-whoosh",
		name: "Color Reveal + Whoosh",
		description: "3s monochrome-to-color gate with its synced whoosh",
		category: "transition",
		keywords: [
			"color reveal",
			"monochrome",
			"divider",
			"whoosh",
			"intro",
			"transition",
		],
		whenToUse:
			"Use as a three-second opening beat that reveals the original color with a full-height glowing divider and synchronized whoosh.",
		defaultDurationSeconds: 3,
		params: {
			template: "split-title",
			label: "MONO",
			secondary: "COLOR",
			accent: "#ffffff",
			background: "#181818",
			foreground: "#ffffff",
		},
		bundle: {
			graphics: [
				{
					name: "3s monochrome-to-color reveal",
					definitionId: "hyperframe",
					startOffsetSeconds: 0,
					durationSeconds: 3,
					params: {
						blendMode: "saturation",
						"camera.depth": 0,
						"camera.locked": true,
						html: COLOR_REVEAL_MASK_HTML,
						opacity: 1,
						sourceHeight: 1920,
						sourceWidth: 1080,
						"transform.perspectiveX": 0,
						"transform.perspectiveY": 0,
						"transform.positionX": 0,
						"transform.positionY": 0,
						"transform.rotate": 0,
						"transform.scaleX": 1,
						"transform.scaleY": 1,
					},
				},
				{
					name: "Full-height glowing white divider — 3s",
					definitionId: "hyperframe",
					startOffsetSeconds: 0,
					durationSeconds: 3,
					params: {
						blendMode: "normal",
						"camera.depth": 0,
						"camera.locked": true,
						html: COLOR_REVEAL_DIVIDER_HTML,
						opacity: 1,
						sourceHeight: 1920,
						sourceWidth: 1080,
						"transform.perspectiveX": 0,
						"transform.perspectiveY": 0,
						"transform.positionX": 0,
						"transform.positionY": 0,
						"transform.rotate": 0,
						"transform.scaleX": 1,
						"transform.scaleY": 1,
					},
				},
			],
			audio: [
				{
					name: "soundreality-whoosh-end-384629",
					libraryAssetId: COLOR_REVEAL_WHOOSH_ASSET_ID,
					startOffsetSeconds: 0.88,
					durationSeconds: 2,
					sourceDurationSeconds: 8.04,
					trimStartSeconds: 0,
					trimEndSeconds: 6.04,
					params: {
						fadeInDuration: 0,
						fadeOutDuration: 0,
						muted: false,
						volume: 0,
					},
				},
			],
		},
	},
	preset({
		id: "product-note",
		name: "Minimal Note",
		description: "Clean topic card with sequential editable rows",
		template: "minimal-note",
		label: "Topic",
		items: "First point\nSecond point\nThird point",
		accent: "#4EA1FF",
		background: "#F6F6F3",
		foreground: "#151515",
		category: "workflow",
		keywords: ["note", "topic", "agenda", "minimal", "product ui"],
		whenToUse: "Use for a short topic, agenda, or three-point explanation.",
		defaultDurationSeconds: 3.2,
		animationIn: "card-glass-unfold",
		animationOut: "card-panel-drop",
		animationInEnd: 24,
		animationOutStart: 86,
		eventAt: 62,
	}),
	preset({
		id: "product-search",
		name: "Search Query",
		description: "Minimal editable search field",
		template: "search-bar",
		label: "How to create better edits?",
		accent: "#4EA1FF",
		background: "#F7F7F5",
		foreground: "#151515",
		category: "workflow",
		keywords: ["search", "query", "research", "browser", "product ui"],
		whenToUse: "Use when a person searches, researches, asks, or discovers.",
		animationIn: "card-window-open",
		animationOut: "card-window-close",
		animationInEnd: 20,
		animationOutStart: 84,
		eventAt: 58,
	}),
	{
		id: "product-goal",
		name: "Goal Slider",
		description: "Animated target slider with current value",
		category: "metrics",
		keywords: ["goal", "slider", "target", "money", "progress"],
		whenToUse:
			"Use for targets, funding, completion, or progress toward a goal.",
		defaultDurationSeconds: 3.06,
		params: GOAL_SLIDER_PARAMS,
		bundle: {
			graphics: [
				{
					name: "Goal Slider",
					definitionId: UI_ELEMENT_DEFINITION_ID,
					startOffsetSeconds: 0,
					durationSeconds: 3.06,
					params: GOAL_SLIDER_PARAMS,
				},
			],
			audio: [
				{
					name: "Goal Slider in",
					libraryAssetId: GOAL_SLIDER_IN_SFX_ASSET_ID,
					startOffsetSeconds: 0,
					durationSeconds: 1.536,
					sourceDurationSeconds: 1.536,
					trimStartSeconds: 0,
					trimEndSeconds: 0,
					params: {
						fadeInDuration: 0,
						fadeOutDuration: 0,
						muted: false,
						volume: -8.9,
					},
				},
				{
					name: "Goal Slider out",
					libraryAssetId: GOAL_SLIDER_OUT_SFX_ASSET_ID,
					startOffsetSeconds: 1.798275,
					durationSeconds: 1.26,
					sourceDurationSeconds: 5.88,
					trimStartSeconds: 0,
					trimEndSeconds: 4.62,
					params: {
						fadeInDuration: 0,
						fadeOutDuration: 0,
						muted: false,
						volume: -8.9,
					},
				},
			],
		},
	},
	preset({
		id: "product-earnings",
		name: "Earnings Metric",
		description: "Compact counting money pill",
		template: "metric-pill",
		label: "$",
		secondary: "Earnings",
		count: 5000,
		accent: "#5DE6A8",
		background: "#050505",
		foreground: "#FFFFFF",
		category: "metrics",
		keywords: ["earnings", "money", "revenue", "counter", "metric"],
		whenToUse: "Use when a spoken money amount needs a compact proof object.",
		animationIn: "counter-count-up",
		animationOut: "counter-metric-dim",
		animationInEnd: 34,
		animationOutStart: 88,
		eventAt: 66,
	}),
	preset({
		id: "product-followers",
		name: "Follower Metric",
		description: "Compact social count pill",
		template: "metric-pill",
		label: "",
		secondary: "Followers",
		count: 100000,
		accent: "#5A8CFF",
		background: "#050505",
		foreground: "#FFFFFF",
		category: "social",
		keywords: ["followers", "audience", "social", "counter", "growth"],
		whenToUse: "Use for audience, views, subscribers, or social proof.",
		animationIn: "counter-metric-glow",
		animationOut: "counter-stat-fade",
		animationInEnd: 32,
		animationOutStart: 88,
		eventAt: 64,
	}),
	preset({
		id: "product-folder",
		name: "Folder Chip",
		description: "Animated file or folder status chip",
		template: "folder-pill",
		label: "Project Files",
		secondary: "3 items",
		accent: "#4EA1FF",
		background: "#050505",
		foreground: "#FFFFFF",
		category: "workflow",
		keywords: ["folder", "files", "download", "project", "storage"],
		whenToUse:
			"Use for files, downloads, folders, assets, or project handoffs.",
		animationIn: "card-panel-rise",
		animationOut: "card-panel-drop",
		animationInEnd: 22,
		animationOutStart: 84,
		eventAt: 55,
	}),
	preset({
		id: "product-message-left",
		name: "Message Left",
		description: "Minimal avatar message from the left",
		template: "avatar-message-left",
		label: "Message content",
		secondary: "Today",
		accent: "#4EA1FF",
		background: "#F7F7F5",
		foreground: "#151515",
		category: "communication",
		keywords: ["message", "chat", "avatar", "dm", "left"],
		whenToUse:
			"Use for the first participant in a conversation or testimonial.",
		animationIn: "chat-slide-thread",
		animationOut: "chat-slide-away",
		animationInEnd: 24,
		animationOutStart: 86,
		eventAt: 62,
	}),
	preset({
		id: "product-message-right",
		name: "Message Right",
		description: "Minimal avatar message from the right",
		template: "avatar-message-right",
		label: "Reply content",
		secondary: "Now",
		accent: "#4EA1FF",
		background: "#F7F7F5",
		foreground: "#151515",
		category: "communication",
		keywords: ["message", "chat", "avatar", "dm", "right", "reply"],
		whenToUse: "Use for the reply side of a conversation or comparison.",
		animationIn: "chat-glow-reply",
		animationOut: "chat-soft-fold",
		animationInEnd: 24,
		animationOutStart: 86,
		eventAt: 62,
	}),
	preset({
		id: "product-team",
		name: "Team Stack",
		description: "Sequential overlapping profile group",
		template: "profile-stack",
		label: "Your team",
		count: 4,
		accent: "#4EA1FF",
		background: "#050505",
		foreground: "#FFFFFF",
		category: "social",
		keywords: ["team", "people", "profiles", "avatars", "community"],
		whenToUse: "Use for teams, customers, collaborators, or communities.",
		animationIn: "card-social-slide",
		animationOut: "card-dots-fade",
		animationInEnd: 28,
		animationOutStart: 86,
		eventAt: 64,
	}),
	preset({
		id: "product-notification",
		name: "App Alert",
		description: "Compact app notification with ping event",
		template: "app-notification",
		label: "New sale",
		secondary: "A new order just arrived",
		accent: "#5DE6A8",
		background: "#F7F7F5",
		foreground: "#151515",
		category: "status",
		keywords: ["notification", "alert", "app", "sale", "message"],
		whenToUse: "Use for alerts, purchases, updates, or status changes.",
		animationIn: "chat-notification-drop",
		animationOut: "chat-notification-swipe",
		animationInEnd: 22,
		animationOutStart: 84,
		animationStrength: 84,
		eventAt: 58,
	}),
	preset({
		id: "editorial-feature-checklist",
		name: "Feature Proof Checklist",
		description:
			"Dark editorial checklist that confirms spoken features in order",
		template: "checkbox-list",
		label: "Everything you see.",
		items: "Motion graphics\nColour grading\nSFX",
		checked: 3,
		accent: "#D8DBDE",
		background: "#24272A",
		foreground: "#FFFFFF",
		category: "proof",
		keywords: ["features", "checklist", "proof", "editing", "deliverables"],
		whenToUse:
			"Use when the speaker names two to four delivered features and each row should confirm in sequence.",
		defaultDurationSeconds: 5.2,
		animationIn: "list-one-by-one",
		animationOut: "list-fade-stagger",
		animationInEnd: 30,
		animationOutStart: 90,
		animationStrength: 72,
		eventAt: 64,
	}),
	{
		id: "rtl-cancellation-checklist-sfx",
		name: "Cancellation Checklist — RTL + SFX",
		description:
			"Hebrew RTL checklist that turns red on cancellation and exits with a stationary blur zoom",
		category: "argument",
		keywords: ["rtl", "hebrew", "checklist", "cancel", "red", "glitch", "sfx"],
		whenToUse:
			"Use when spoken excuses appear one by one, then the argument is cancelled with a red state and synchronized glitch.",
		defaultDurationSeconds: 5.625,
		params: RTL_CANCELLATION_CHECKLIST_PARAMS,
		bundle: {
			graphics: [
				{
					name: "Cancellation Checklist — RTL",
					definitionId: UI_ELEMENT_DEFINITION_ID,
					startOffsetSeconds: 0,
					durationSeconds: 5.625,
					params: RTL_CANCELLATION_CHECKLIST_PARAMS,
				},
			],
			audio: [
				{
					name: "alexzavesa-woosh-glitch-1-463012",
					libraryAssetId: CANCELLATION_CHECKLIST_GLITCH_ASSET_ID,
					startOffsetSeconds: 4.745,
					durationSeconds: 1.985281,
					sourceDurationSeconds: 1.985281,
					trimStartSeconds: 0,
					trimEndSeconds: 0,
					params: {
						fadeInDuration: 0,
						fadeOutDuration: 0.12,
						muted: false,
						volume: -6,
					},
				},
			],
		},
	},
	preset({
		id: "editorial-reject-task",
		name: "Reject Task",
		description: "Readable task enters first, then checks and rejects in red",
		template: "checkbox-list",
		label: "Stop wasting money",
		items: "Testing editors",
		checked: 1,
		accent: "#E04747",
		background: "#25282B",
		foreground: "#FFFFFF",
		category: "argument",
		keywords: ["reject", "stop", "task", "strike", "negative", "editor"],
		whenToUse:
			"Use for a spoken behavior that must remain readable before a red check, strike, or rejection event.",
		defaultDurationSeconds: 3,
		animationIn: "list-all-then-check",
		animationOut: "list-sweep-clear",
		animationInEnd: 26,
		animationOutStart: 86,
		animationStrength: 82,
		eventAt: 62,
	}),
	preset({
		id: "editorial-comment-reply",
		name: "Comment Reply",
		description: "Compact creator comment prompt with a typed reply event",
		template: "app-notification",
		label: "@creator",
		secondary: "Comment: Kallaway",
		accent: "#EF4444",
		background: "#F8F8F5",
		foreground: "#171717",
		category: "social",
		keywords: ["comment", "reply", "creator", "cta", "social", "typing"],
		whenToUse:
			"Use for a comment-keyword CTA; time the typed keyword and confirmation event to the spoken instruction.",
		defaultDurationSeconds: 3.5,
		animationIn: "chat-message-type",
		animationOut: "chat-soft-fold",
		animationInEnd: 34,
		animationOutStart: 88,
		animationStrength: 76,
		eventAt: 68,
	}),
	preset({
		id: "neon-cta",
		name: "Neon CTA",
		description: "Glowing editable call-to-action",
		template: "neon-button",
		label: "Start Now",
	}),
	preset({
		id: "pulse-click",
		name: "Click Pulse",
		description: "Button with click ripple",
		template: "click-button",
		label: "Tap Here",
		accent: "#ff2bd6",
	}),
	preset({
		id: "subscribe",
		name: "Subscribe Button",
		description: "Creator video subscribe button",
		template: "subscribe-button",
		label: "Subscribe",
		accent: "#ff0033",
	}),
	preset({
		id: "rotating-bars",
		name: "Rotating Bars",
		description: "Looping radial motion bars",
		template: "rotating-bars",
		label: "Loading",
	}),
	preset({
		id: "flipping-bars",
		name: "Flipping Bars",
		description: "Motion graphic equalizer bars",
		template: "flipping-bars",
		label: "Sync",
	}),
	preset({
		id: "audio-waveform",
		name: "Waveform",
		description: "Animated waveform style bars",
		template: "waveform",
		label: "Audio",
		accent: "#22c55e",
	}),
	preset({
		id: "anime-chat",
		name: "Anime Chat",
		description: "Chat bubble with subtitle line",
		template: "anime-chat-bubble",
		label: "That was close!",
		secondary: "Episode 04",
		accent: "#f472b6",
	}),
	preset({
		id: "progress-upload",
		name: "Progress",
		description: "Editable progress bar",
		template: "progress-bar",
		label: "Uploading",
		progress: 72,
	}),
	preset({
		id: "xp-progress",
		name: "XP Bar",
		description: "Game-like progress tracker",
		template: "progress-bar",
		label: "Level Progress",
		accent: "#a3e635",
		progress: 48,
	}),
	preset({
		id: "bullet-stack",
		name: "Bullet Stack",
		description: "Piling bullet list",
		template: "bullet-list",
		label: "Plan",
		items: "Hook\nProblem\nProof\nOffer",
	}),
	preset({
		id: "checklist",
		name: "Checklist",
		description: "Animated checklist",
		template: "checkbox-list",
		label: "Tasks",
		items: "Script\nRecord\nEdit\nPublish",
		checked: 3,
		accent: "#22c55e",
	}),
	preset({
		id: "lower-third-clean",
		name: "Lower Third",
		description: "Name and role banner",
		template: "lower-third",
		label: "Alex Morgan",
		secondary: "Creative Director",
	}),
	preset({
		id: "lower-third-news",
		name: "News Lower Third",
		description: "Broadcast-style lower third",
		template: "lower-third",
		label: "Breaking Update",
		secondary: "Live from studio",
		accent: "#ef4444",
	}),
	preset({
		id: "counter-big",
		name: "Counter",
		description: "Large animated number",
		template: "counter",
		label: "Downloads",
		count: 128,
		// Copied from the Counter + Typing pairing authored in ROGA2.
		defaultDurationSeconds: 1.74,
		bundleAudio: [
			{
				name: "Typing",
				libraryAssetId: COUNTER_TYPING_SFX_ASSET_ID,
				startOffsetSeconds: 0.09808333333333333,
				durationSeconds: 1.3114166666666668,
				sourceDurationSeconds: 1.3114166666666668,
				trimStartSeconds: 0,
				trimEndSeconds: 0,
				params: {
					fadeInDuration: 0,
					fadeOutDuration: 0,
					muted: false,
					volume: -9.6,
				},
			},
		],
	}),
	preset({
		id: "badge-new",
		name: "Badge",
		description: "Compact label badge",
		template: "badge",
		label: "NEW",
		accent: "#38bdf8",
	}),
	preset({
		id: "callout-tip",
		name: "Callout",
		description: "Highlighted callout panel",
		template: "callout",
		label: "Pro Tip",
		secondary: "Keep it short",
		accent: "#f59e0b",
	}),
	preset({
		id: "glass-panel",
		name: "Panel",
		description: "Editable info panel",
		template: "panel",
		label: "Key Detail",
		secondary: "Supports flexible text",
	}),
	preset({
		id: "chart-bars",
		name: "Bar Chart",
		description: "Chart-style motion graphic",
		template: "chart-bars",
		label: "Growth",
		accent: "#22d3ee",
	}),
	preset({
		id: "line-chart",
		name: "Line Chart",
		description: "Trend line motion graphic",
		template: "line-chart",
		label: "Trend",
		accent: "#84cc16",
	}),
	preset({
		id: "loading-ring",
		name: "Loading Ring",
		description: "Circular progress spinner",
		template: "loading-ring",
		label: "Processing",
		progress: 75,
	}),
	preset({
		id: "notification",
		name: "Notification",
		description: "App notification card",
		template: "notification",
		label: "New message",
		secondary: "Just now",
		accent: "#60a5fa",
	}),
	preset({
		id: "price-tag",
		name: "Price Tag",
		description: "Sale and pricing label",
		template: "price-tag",
		label: "$19",
		secondary: "Limited offer",
		accent: "#f97316",
	}),
	preset({
		id: "app-window",
		name: "App Window",
		description: "Software window overlay",
		template: "app-window",
		label: "Dashboard",
		secondary: "Live preview",
	}),
	preset({
		id: "timeline-stepper",
		name: "Stepper",
		description: "Timeline step indicator",
		template: "timeline-stepper",
		label: "Step 3",
		secondary: "Review",
		progress: 60,
	}),
	preset({
		id: "split-title",
		name: "Split Title",
		description: "Motion title block",
		template: "split-title",
		label: "Before",
		secondary: "After",
		accent: "#c084fc",
	}),
	preset({
		id: "social-card",
		name: "Social Card",
		description: "Post-style information card",
		template: "social-card",
		label: "@opencut",
		secondary: "New edit is live",
	}),
	preset({
		id: "stats-grid",
		name: "Stats Grid",
		description: "Grid of metric cards",
		template: "stats-grid",
		label: "Metrics",
		secondary: "+24% this week",
		count: 24,
	}),
	preset({
		id: "countdown",
		name: "Countdown",
		description: "Circular countdown graphic",
		template: "countdown",
		label: "Starting",
		secondary: "00:10",
		progress: 88,
	}),
	preset({
		id: "hud-countdown",
		name: "HUD Countdown",
		description: "Glass neon countdown ring",
		template: "hud-countdown",
		label: "59",
		secondary: "00:59",
		accent: "#B6FF73",
		background: "#102014",
		foreground: "#C9FF8F",
		progress: 82,
	}),
	preset({
		id: "battery-drain",
		name: "Battery Drain",
		description: "Sci-fi neon battery power overlay",
		template: "battery-drain",
		label: "POWER",
		secondary: "DRAINING",
		accent: "#8BFFE8",
		background: "#071014",
		foreground: "#E9FFF8",
		progress: 86,
		intensity: 82,
		batteryMode: "drain",
	}),
	preset({
		id: "hud-radar-sweep",
		name: "Radar Sweep",
		description: "Circular glass radar with neon sweep",
		template: "hud-radar-sweep",
		label: "RADAR",
		secondary: "SECTOR 07",
		accent: "#70FFB8",
		background: "#061211",
		foreground: "#E8FFF6",
		progress: 76,
		intensity: 74,
	}),
	preset({
		id: "hud-target-lock",
		name: "Target Lock",
		description: "Sci-fi lock-on reticle overlay",
		template: "hud-target-lock",
		label: "LOCK",
		secondary: "ACQUIRING",
		accent: "#FF4D6D",
		background: "#12070B",
		foreground: "#FFEAF0",
		progress: 68,
		intensity: 86,
	}),
	preset({
		id: "hud-signal-scanner",
		name: "Signal Scanner",
		description: "Neon waveform and signal bars",
		template: "hud-signal-scanner",
		label: "SIGNAL",
		secondary: "LIVE FEED",
		accent: "#72D7FF",
		background: "#06101A",
		foreground: "#E9FAFF",
		progress: 58,
		intensity: 70,
	}),
	preset({
		id: "hud-data-core",
		name: "Data Core",
		description: "Orbital data core status graphic",
		template: "hud-data-core",
		label: "CORE",
		secondary: "SYNCED",
		accent: "#B8FF6A",
		background: "#0A1306",
		foreground: "#F4FFE8",
		progress: 84,
		intensity: 78,
	}),
	preset({
		id: "hud-alert-beacon",
		name: "Alert Beacon",
		description: "Glass warning beacon with pulse scan",
		template: "hud-alert-beacon",
		label: "ALERT",
		secondary: "BREACH",
		accent: "#FFB84D",
		background: "#160B04",
		foreground: "#FFF4E5",
		progress: 46,
		intensity: 92,
	}),
	preset({
		id: "hud-direction-shift",
		name: "Direction Shift",
		description: "Magical sci-fi reversal arrows",
		template: "hud-direction-shift",
		label: "שינוי כיוון",
		secondary: "DIRECTION SHIFT",
		accent: "#83FFE8",
		background: "#0B0714",
		foreground: "#FFF7FF",
		progress: 72,
		intensity: 88,
	}),
	preset({
		id: "direction-cross-arrows",
		name: "Direction Arrows",
		description: "Minimal crossed neon direction arrows",
		template: "direction-cross-arrows",
		label: "",
		secondary: "",
		accent: "#7CFFE4",
		background: "#060B10",
		foreground: "#F7FBFF",
		progress: 82,
		intensity: 72,
	}),
	preset({
		id: "wasted-overlay",
		name: "Wasted Overlay",
		description: "Full-screen red death overlay",
		template: "wasted-overlay",
		label: "WASTED",
		secondary: "MISSION FAILED",
		accent: "#D91E36",
		background: "#070000",
		foreground: "#F2E6E0",
		progress: 72,
		intensity: 86,
		screenMode: "wide",
	}),
	preset({
		id: "toggle-switch",
		name: "Toggle",
		description: "Animated toggle switch",
		template: "toggle-switch",
		label: "Enabled",
		secondary: "Auto mode",
		progress: 100,
	}),
	preset({
		id: "rating-stars",
		name: "Rating",
		description: "Star rating graphic",
		template: "rating-stars",
		label: "Rating",
		secondary: "4 out of 5",
		count: 4,
		accent: "#facc15",
	}),
	preset({
		id: "leaderboard",
		name: "Leaderboard",
		description: "Ranked list card",
		template: "leaderboard",
		label: "Leaderboard",
		secondary: "Top creators",
		items: "Ari\nNoa\nMika\nLee",
	}),
	preset({
		id: "tooltip",
		name: "Tooltip",
		description: "Pointer tooltip label",
		template: "tooltip",
		label: "Drag to adjust",
		secondary: "Value: 64",
	}),
	preset({
		id: "carousel-dots",
		name: "Carousel Dots",
		description: "Slide indicator dots",
		template: "carousel-dots",
		label: "Slide 3",
		secondary: "Gallery",
	}),
];
