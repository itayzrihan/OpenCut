import type { TextCaptionRevealMode, TextWordTransitionIn } from "@/timeline";

export type UiElementAnimationGroup =
	| "button"
	| "progress"
	| "list"
	| "loader"
	| "chat"
	| "lower-third"
	| "counter"
	| "chart"
	| "card"
	| "overlay"
	| "direction";

export type UiElementAnimationSide = "in" | "out";

export type UiElementAnimationOption = {
	value: string;
	label: string;
};

export const UI_ELEMENT_TEMPLATE_OPTIONS: UiElementAnimationOption[] = [
	{ value: "neon-button", label: "Neon Button" },
	{ value: "click-button", label: "Click Button" },
	{ value: "rotating-bars", label: "Rotating Bars" },
	{ value: "flipping-bars", label: "Flipping Bars" },
	{ value: "anime-chat-bubble", label: "Anime Chat Bubble" },
	{ value: "progress-bar", label: "Progress Bar" },
	{ value: "bullet-list", label: "Piling Bullet List" },
	{ value: "checkbox-list", label: "Checkbox List" },
	{ value: "lower-third", label: "Lower Third" },
	{ value: "counter", label: "Counter" },
	{ value: "badge", label: "Badge" },
	{ value: "panel", label: "Panel" },
	{ value: "callout", label: "Callout" },
	{ value: "chart-bars", label: "Chart Bars" },
	{ value: "line-chart", label: "Line Chart" },
	{ value: "loading-ring", label: "Loading Ring" },
	{ value: "notification", label: "Notification" },
	{ value: "subscribe-button", label: "Subscribe Button" },
	{ value: "price-tag", label: "Price Tag" },
	{ value: "app-window", label: "App Window" },
	{ value: "timeline-stepper", label: "Timeline Stepper" },
	{ value: "split-title", label: "Split Title" },
	{ value: "waveform", label: "Waveform" },
	{ value: "social-card", label: "Social Card" },
	{ value: "stats-grid", label: "Stats Grid" },
	{ value: "countdown", label: "Countdown" },
	{ value: "hud-countdown", label: "HUD Countdown" },
	{ value: "battery-drain", label: "Battery Drain" },
	{ value: "hud-radar-sweep", label: "HUD Radar Sweep" },
	{ value: "hud-target-lock", label: "HUD Target Lock" },
	{ value: "hud-signal-scanner", label: "HUD Signal Scanner" },
	{ value: "hud-data-core", label: "HUD Data Core" },
	{ value: "hud-alert-beacon", label: "HUD Alert Beacon" },
	{ value: "hud-direction-shift", label: "HUD Direction Shift" },
	{ value: "direction-cross-arrows", label: "Direction Cross Arrows" },
	{ value: "wasted-overlay", label: "Wasted Overlay" },
	{ value: "toggle-switch", label: "Toggle Switch" },
	{ value: "rating-stars", label: "Rating Stars" },
	{ value: "leaderboard", label: "Leaderboard" },
	{ value: "tooltip", label: "Tooltip" },
	{ value: "carousel-dots", label: "Carousel Dots" },
];

const TEMPLATE_GROUPS: Record<string, UiElementAnimationGroup> = {
	"neon-button": "button",
	"click-button": "button",
	"subscribe-button": "button",
	"progress-bar": "progress",
	"loading-ring": "progress",
	countdown: "progress",
	"hud-countdown": "progress",
	"battery-drain": "progress",
	"hud-radar-sweep": "progress",
	"hud-target-lock": "progress",
	"hud-signal-scanner": "progress",
	"hud-data-core": "progress",
	"hud-alert-beacon": "progress",
	"hud-direction-shift": "progress",
	"bullet-list": "list",
	"checkbox-list": "list",
	leaderboard: "list",
	"rotating-bars": "loader",
	"flipping-bars": "loader",
	waveform: "loader",
	"anime-chat-bubble": "chat",
	notification: "chat",
	tooltip: "chat",
	"lower-third": "lower-third",
	"split-title": "lower-third",
	counter: "counter",
	"stats-grid": "counter",
	"rating-stars": "counter",
	"chart-bars": "chart",
	"line-chart": "chart",
	badge: "card",
	panel: "card",
	callout: "card",
	"price-tag": "card",
	"app-window": "card",
	"timeline-stepper": "card",
	"social-card": "card",
	"toggle-switch": "card",
	"carousel-dots": "card",
	"wasted-overlay": "overlay",
	"direction-cross-arrows": "direction",
};

const commonIn = [{ value: "auto", label: "Auto" }];
const commonOut = [{ value: "auto", label: "Auto" }];

const IN_ANIMATION_GROUPS: Record<
	UiElementAnimationGroup,
	UiElementAnimationOption[]
> = {
	button: [
		...commonIn,
		{ value: "button-spatial-reveal", label: "Spatial reveal" },
		{ value: "button-pressure-pop", label: "Pressure pop" },
		{ value: "button-ripple-expand", label: "Ripple expand" },
		{ value: "button-neon-charge", label: "Neon charge" },
		{ value: "button-slide-click-ready", label: "Slide click ready" },
		{ value: "button-magnetic-snap", label: "Magnetic snap" },
		{ value: "button-outline-draw", label: "Outline draw" },
		{ value: "button-gloss-sweep", label: "Gloss sweep" },
		{ value: "button-depth-bounce", label: "Depth bounce" },
		{ value: "button-laser-unmask", label: "Laser unmask" },
	],
	progress: [
		...commonIn,
		{ value: "progress-count-up", label: "Count up fill" },
		{ value: "progress-scan-fill", label: "Scan fill" },
		{ value: "progress-buffer-pulse", label: "Buffer pulse" },
		{ value: "progress-segment-build", label: "Segment build" },
		{ value: "progress-liquid-rise", label: "Liquid rise" },
		{ value: "progress-overload-charge", label: "Overload charge" },
		{ value: "progress-spark-run", label: "Spark run" },
		{ value: "progress-meter-sweep", label: "Meter sweep" },
		{ value: "progress-check-fill", label: "Check fill" },
		{ value: "progress-stripe-flow", label: "Stripe flow" },
	],
	list: [
		...commonIn,
		{ value: "list-one-by-one", label: "Reveal one by one" },
		{ value: "list-all-then-check", label: "All, then checkmarks" },
		{ value: "list-grow-glow-stagger", label: "Grow glow one by one" },
		{ value: "list-type-in-rows", label: "Type rows" },
		{ value: "list-slide-stack", label: "Slide stack" },
		{ value: "list-pile-drop", label: "Pile drop" },
		{ value: "list-check-sweep", label: "Check sweep" },
		{ value: "list-bullet-pop", label: "Bullet pop" },
		{ value: "list-row-highlight", label: "Row highlight" },
		{ value: "list-cascade-fade", label: "Cascade fade" },
	],
	loader: [
		...commonIn,
		{ value: "loader-spin-up", label: "Spin up" },
		{ value: "loader-bars-rise", label: "Bars rise" },
		{ value: "loader-wave-sync", label: "Wave sync" },
		{ value: "loader-orbit-assemble", label: "Orbit assemble" },
		{ value: "loader-pulse-lock", label: "Pulse lock" },
		{ value: "loader-frequency-build", label: "Frequency build" },
		{ value: "loader-flip-in", label: "Flip in" },
		{ value: "loader-signal-boost", label: "Signal boost" },
		{ value: "loader-radar-sweep", label: "Radar sweep" },
		{ value: "loader-comet-loop", label: "Comet loop" },
	],
	chat: [
		...commonIn,
		{ value: "chat-bubble-pop", label: "Bubble pop" },
		{ value: "chat-tail-draw", label: "Tail draw" },
		{ value: "chat-message-type", label: "Message type" },
		{ value: "chat-slide-thread", label: "Slide thread" },
		{ value: "chat-notification-drop", label: "Notification drop" },
		{ value: "chat-dot-typing", label: "Typing dots" },
		{ value: "chat-glow-reply", label: "Glow reply" },
		{ value: "chat-sticker-bounce", label: "Sticker bounce" },
		{ value: "chat-ping-arrive", label: "Ping arrive" },
		{ value: "chat-soft-unfold", label: "Soft unfold" },
	],
	"lower-third": [
		...commonIn,
		{ value: "lower-third-bar-wipe", label: "Bar wipe" },
		{ value: "lower-third-name-type", label: "Name type" },
		{ value: "lower-third-slide-lock", label: "Slide lock" },
		{ value: "lower-third-broadcast-snap", label: "Broadcast snap" },
		{ value: "lower-third-stripe-reveal", label: "Stripe reveal" },
		{ value: "lower-third-corner-build", label: "Corner build" },
		{ value: "lower-third-glass-rise", label: "Glass rise" },
		{ value: "lower-third-ticker-in", label: "Ticker in" },
		{ value: "lower-third-split-open", label: "Split open" },
		{ value: "lower-third-flash-tag", label: "Flash tag" },
	],
	counter: [
		...commonIn,
		{ value: "counter-count-up", label: "Count up" },
		{ value: "counter-odometer-roll", label: "Odometer roll" },
		{ value: "counter-score-pop", label: "Score pop" },
		{ value: "counter-digit-flip", label: "Digit flip" },
		{ value: "counter-stat-rise", label: "Stat rise" },
		{ value: "counter-badge-stamp", label: "Badge stamp" },
		{ value: "counter-spark-count", label: "Spark count" },
		{ value: "counter-metric-glow", label: "Metric glow" },
		{ value: "counter-grid-cascade", label: "Grid cascade" },
		{ value: "counter-star-fill", label: "Star fill" },
	],
	chart: [
		...commonIn,
		{ value: "chart-bars-grow", label: "Bars grow" },
		{ value: "chart-line-draw", label: "Line draw" },
		{ value: "chart-axis-wipe", label: "Axis wipe" },
		{ value: "chart-data-pop", label: "Data pop" },
		{ value: "chart-trend-sweep", label: "Trend sweep" },
		{ value: "chart-grid-fade", label: "Grid fade" },
		{ value: "chart-column-cascade", label: "Column cascade" },
		{ value: "chart-point-spark", label: "Point spark" },
		{ value: "chart-metric-snap", label: "Metric snap" },
		{ value: "chart-forecast-glow", label: "Forecast glow" },
	],
	card: [
		...commonIn,
		{ value: "card-glass-unfold", label: "Glass unfold" },
		{ value: "card-panel-rise", label: "Panel rise" },
		{ value: "card-badge-stamp", label: "Badge stamp" },
		{ value: "card-callout-pulse", label: "Callout pulse" },
		{ value: "card-window-open", label: "Window open" },
		{ value: "card-price-tag-swing", label: "Price tag swing" },
		{ value: "card-toggle-snap", label: "Toggle snap" },
		{ value: "card-dots-progress", label: "Dots progress" },
		{ value: "card-social-slide", label: "Social slide" },
		{ value: "card-stepper-build", label: "Stepper build" },
	],
	overlay: [
		...commonIn,
		{ value: "overlay-red-flash", label: "Red flash" },
		{ value: "overlay-title-drop", label: "Title drop" },
		{ value: "overlay-slow-fade", label: "Slow fade" },
		{ value: "overlay-vignette-crush", label: "Vignette crush" },
		{ value: "overlay-glow-bloom", label: "Glow bloom" },
		{ value: "overlay-black-wipe", label: "Black wipe" },
		{ value: "overlay-blood-wash", label: "Blood wash" },
		{ value: "overlay-noise-burst", label: "Noise burst" },
		{ value: "overlay-smash-pop", label: "Smash pop" },
		{ value: "overlay-scanline-build", label: "Scanline build" },
	],
	direction: [
		...commonIn,
		{ value: "direction-line-draw", label: "Line draw" },
		{ value: "direction-cross-trace", label: "Cross trace" },
		{ value: "direction-neon-spark", label: "Neon spark" },
		{ value: "direction-opposite-slide", label: "Opposite slide" },
		{ value: "direction-center-snap", label: "Center snap" },
		{ value: "direction-arrow-grow", label: "Arrow grow" },
		{ value: "direction-light-sweep", label: "Light sweep" },
		{ value: "direction-pulse-in", label: "Pulse in" },
		{ value: "direction-rotate-lock", label: "Rotate lock" },
		{ value: "direction-glass-focus", label: "Glass focus" },
	],
};

const OUT_ANIMATION_GROUPS: Record<
	UiElementAnimationGroup,
	UiElementAnimationOption[]
> = {
	button: [
		...commonOut,
		{ value: "button-click-explode", label: "Click explode" },
		{ value: "button-click-break", label: "Click break" },
		{ value: "button-shrink-away", label: "Shrink away" },
		{ value: "button-ripple-pop", label: "Ripple pop" },
		{ value: "button-press-collapse", label: "Press collapse" },
		{ value: "button-neon-burnout", label: "Neon burnout" },
		{ value: "button-snap-off", label: "Snap off" },
		{ value: "button-pixel-burst", label: "Pixel burst" },
		{ value: "button-flip-dismiss", label: "Flip dismiss" },
		{ value: "button-slide-release", label: "Slide release" },
	],
	progress: [
		...commonOut,
		{ value: "progress-overload-burst", label: "Overload burst" },
		{ value: "progress-drain-empty", label: "Drain empty" },
		{ value: "progress-complete-flash", label: "Complete flash" },
		{ value: "progress-bar-shatter", label: "Bar shatter" },
		{ value: "progress-fill-collapse", label: "Fill collapse" },
		{ value: "progress-alert-pulse", label: "Alert pulse" },
		{ value: "progress-spark-dissolve", label: "Spark dissolve" },
		{ value: "progress-meter-cut", label: "Meter cut" },
		{ value: "progress-zip-away", label: "Zip away" },
		{ value: "progress-check-pop", label: "Check pop" },
	],
	list: [
		...commonOut,
		{ value: "list-check-complete", label: "Check complete" },
		{ value: "list-row-collapse", label: "Row collapse" },
		{ value: "list-stack-fly", label: "Stack fly" },
		{ value: "list-fade-stagger", label: "Fade stagger" },
		{ value: "list-shred-away", label: "Shred away" },
		{ value: "list-sweep-clear", label: "Sweep clear" },
		{ value: "list-glow-off", label: "Glow off" },
		{ value: "list-bullet-burst", label: "Bullet burst" },
		{ value: "list-compress", label: "Compress" },
		{ value: "list-paper-drop", label: "Paper drop" },
	],
	loader: [
		...commonOut,
		{ value: "loader-spin-stop", label: "Spin stop" },
		{ value: "loader-bars-drop", label: "Bars drop" },
		{ value: "loader-wave-dissolve", label: "Wave dissolve" },
		{ value: "loader-orbit-scatter", label: "Orbit scatter" },
		{ value: "loader-pulse-fade", label: "Pulse fade" },
		{ value: "loader-frequency-cut", label: "Frequency cut" },
		{ value: "loader-flip-out", label: "Flip out" },
		{ value: "loader-signal-loss", label: "Signal loss" },
		{ value: "loader-radar-blank", label: "Radar blank" },
		{ value: "loader-comet-burn", label: "Comet burn" },
	],
	chat: [
		...commonOut,
		{ value: "chat-bubble-burst", label: "Bubble burst" },
		{ value: "chat-tail-fold", label: "Tail fold" },
		{ value: "chat-message-erase", label: "Message erase" },
		{ value: "chat-slide-away", label: "Slide away" },
		{ value: "chat-notification-swipe", label: "Notification swipe" },
		{ value: "chat-dot-fade", label: "Dots fade" },
		{ value: "chat-glow-mute", label: "Glow mute" },
		{ value: "chat-sticker-fall", label: "Sticker fall" },
		{ value: "chat-ping-pop", label: "Ping pop" },
		{ value: "chat-soft-fold", label: "Soft fold" },
	],
	"lower-third": [
		...commonOut,
		{ value: "lower-third-bar-wipe-out", label: "Bar wipe out" },
		{ value: "lower-third-name-erase", label: "Name erase" },
		{ value: "lower-third-slide-release", label: "Slide release" },
		{ value: "lower-third-broadcast-cut", label: "Broadcast cut" },
		{ value: "lower-third-stripe-close", label: "Stripe close" },
		{ value: "lower-third-corner-break", label: "Corner break" },
		{ value: "lower-third-glass-drop", label: "Glass drop" },
		{ value: "lower-third-ticker-out", label: "Ticker out" },
		{ value: "lower-third-split-close", label: "Split close" },
		{ value: "lower-third-flash-out", label: "Flash out" },
	],
	counter: [
		...commonOut,
		{ value: "counter-overflow-pop", label: "Overflow pop" },
		{ value: "counter-odometer-spinout", label: "Odometer spinout" },
		{ value: "counter-score-burst", label: "Score burst" },
		{ value: "counter-digit-fall", label: "Digit fall" },
		{ value: "counter-stat-fade", label: "Stat fade" },
		{ value: "counter-badge-crack", label: "Badge crack" },
		{ value: "counter-spark-dissolve", label: "Spark dissolve" },
		{ value: "counter-metric-dim", label: "Metric dim" },
		{ value: "counter-grid-fold", label: "Grid fold" },
		{ value: "counter-star-scatter", label: "Star scatter" },
	],
	chart: [
		...commonOut,
		{ value: "chart-bars-drop", label: "Bars drop" },
		{ value: "chart-line-erase", label: "Line erase" },
		{ value: "chart-axis-cut", label: "Axis cut" },
		{ value: "chart-data-scatter", label: "Data scatter" },
		{ value: "chart-trend-fall", label: "Trend fall" },
		{ value: "chart-grid-blank", label: "Grid blank" },
		{ value: "chart-column-collapse", label: "Column collapse" },
		{ value: "chart-point-burst", label: "Point burst" },
		{ value: "chart-metric-fade", label: "Metric fade" },
		{ value: "chart-forecast-dim", label: "Forecast dim" },
	],
	card: [
		...commonOut,
		{ value: "card-glass-shatter", label: "Glass shatter" },
		{ value: "card-panel-drop", label: "Panel drop" },
		{ value: "card-badge-crack", label: "Badge crack" },
		{ value: "card-callout-blink", label: "Callout blink" },
		{ value: "card-window-close", label: "Window close" },
		{ value: "card-price-tag-fall", label: "Price tag fall" },
		{ value: "card-toggle-off", label: "Toggle off" },
		{ value: "card-dots-fade", label: "Dots fade" },
		{ value: "card-social-swipe", label: "Social swipe" },
		{ value: "card-stepper-complete", label: "Stepper complete" },
	],
	overlay: [
		...commonOut,
		{ value: "overlay-fade-clear", label: "Fade clear" },
		{ value: "overlay-red-drain", label: "Red drain" },
		{ value: "overlay-title-shatter", label: "Title shatter" },
		{ value: "overlay-black-wipe-out", label: "Black wipe out" },
		{ value: "overlay-glitch-cut", label: "Glitch cut" },
		{ value: "overlay-drop-away", label: "Drop away" },
		{ value: "overlay-burn-dim", label: "Burn dim" },
		{ value: "overlay-noise-dissolve", label: "Noise dissolve" },
		{ value: "overlay-snap-close", label: "Snap close" },
		{ value: "overlay-slide-clear", label: "Slide clear" },
	],
	direction: [
		...commonOut,
		{ value: "direction-line-retract", label: "Line retract" },
		{ value: "direction-cross-fade", label: "Cross fade" },
		{ value: "direction-neon-off", label: "Neon off" },
		{ value: "direction-opposite-slide-out", label: "Opposite slide out" },
		{ value: "direction-center-collapse", label: "Center collapse" },
		{ value: "direction-arrow-shrink", label: "Arrow shrink" },
		{ value: "direction-light-release", label: "Light release" },
		{ value: "direction-pulse-out", label: "Pulse out" },
		{ value: "direction-rotate-away", label: "Rotate away" },
		{ value: "direction-glass-dim", label: "Glass dim" },
	],
};

export const UI_ELEMENT_TEXT_REVEAL_OPTIONS: Array<{
	value: TextCaptionRevealMode;
	label: string;
}> = [
	{ value: "determined-by-preset", label: "Determined by animation" },
	{ value: "row", label: "Whole row" },
	{ value: "spoken-word", label: "Spoken word only" },
	{ value: "spoken-word-keep", label: "Spoken word, keep previous" },
	{ value: "emphasize-spoken", label: "Emphasize spoken" },
	{ value: "emphasize-spoken-keep", label: "Keep emphasized" },
	{ value: "letter-by-letter", label: "Letter by letter typing" },
	{ value: "growing-row", label: "Growing row" },
];

export const UI_ELEMENT_TEXT_TRANSITION_OPTIONS: Array<{
	value: TextWordTransitionIn;
	label: string;
}> = [
	{ value: "none", label: "None" },
	{ value: "fade", label: "Fade" },
	{ value: "blur", label: "Blur build" },
	{ value: "zoom", label: "Zoom" },
	{ value: "blur-zoom", label: "Blur zoom" },
	{ value: "rise", label: "Rise" },
	{ value: "slide", label: "Slide" },
	{ value: "typewriter", label: "Type letter by letter" },
	{ value: "glow-dissolve", label: "Glow blur dissolve" },
];

export function getUiElementAnimationGroup({
	template,
}: {
	template: string;
}): UiElementAnimationGroup {
	return TEMPLATE_GROUPS[template] ?? "card";
}

export function getUiElementAnimationOptions({
	template,
	side,
}: {
	template: string;
	side: UiElementAnimationSide;
}): UiElementAnimationOption[] {
	const group = getUiElementAnimationGroup({ template });
	return side === "in"
		? IN_ANIMATION_GROUPS[group]
		: OUT_ANIMATION_GROUPS[group];
}

export function getAllUiElementAnimationOptions({
	side,
}: {
	side: UiElementAnimationSide;
}): UiElementAnimationOption[] {
	const seen = new Set<string>();
	const groups = side === "in" ? IN_ANIMATION_GROUPS : OUT_ANIMATION_GROUPS;
	return Object.values(groups)
		.flat()
		.filter((option) => {
			if (seen.has(option.value)) return false;
			seen.add(option.value);
			return true;
		});
}
