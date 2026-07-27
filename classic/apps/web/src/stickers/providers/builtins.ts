import { buildStickerId, parseStickerId } from "../sticker-id";
import type {
	StickerBrowseResult,
	StickerItem,
	StickerProvider,
	StickerSearchResult,
} from "../types";

const BUILTINS_PROVIDER_ID = "builtins";

interface BuiltinSticker {
	id: string;
	name: string;
	text: string;
	keywords: string[];
	background?: string;
	foreground?: string;
	shape?: "circle" | "square" | "pill" | "burst" | "plain" | "callout";
}

const EMOJI_STICKERS: BuiltinSticker[] = [
	{ id: "emoji-grin", name: "Grin", text: "\u{1F600}", keywords: ["emoji", "happy"] },
	{ id: "emoji-joy", name: "Tears of Joy", text: "\u{1F602}", keywords: ["emoji", "laugh"] },
	{ id: "emoji-heart-eyes", name: "Heart Eyes", text: "\u{1F60D}", keywords: ["emoji", "love"] },
	{ id: "emoji-sunglasses", name: "Sunglasses", text: "\u{1F60E}", keywords: ["emoji", "cool"] },
	{ id: "emoji-thinking", name: "Thinking", text: "\u{1F914}", keywords: ["emoji", "think"] },
	{ id: "emoji-shocked", name: "Shocked", text: "\u{1F62E}", keywords: ["emoji", "wow"] },
	{ id: "emoji-fire", name: "Fire", text: "\u{1F525}", keywords: ["emoji", "hot"] },
	{ id: "emoji-sparkles", name: "Sparkles", text: "\u{2728}", keywords: ["emoji", "shine"] },
	{ id: "emoji-star", name: "Star", text: "\u{2B50}", keywords: ["emoji", "favorite"] },
	{ id: "emoji-lightning", name: "Lightning", text: "\u{26A1}", keywords: ["emoji", "energy"] },
	{ id: "emoji-boom", name: "Boom", text: "\u{1F4A5}", keywords: ["emoji", "impact"] },
	{ id: "emoji-100", name: "100", text: "\u{1F4AF}", keywords: ["emoji", "score"] },
	{ id: "emoji-check", name: "Check", text: "\u{2705}", keywords: ["emoji", "done"] },
	{ id: "emoji-cross", name: "Cross", text: "\u{274C}", keywords: ["emoji", "no"] },
	{ id: "emoji-warning", name: "Warning", text: "\u{26A0}\u{FE0F}", keywords: ["emoji", "alert"] },
	{ id: "emoji-eyes", name: "Eyes", text: "\u{1F440}", keywords: ["emoji", "look"] },
	{ id: "emoji-clap", name: "Clap", text: "\u{1F44F}", keywords: ["emoji", "applause"] },
	{ id: "emoji-thumbs-up", name: "Thumbs Up", text: "\u{1F44D}", keywords: ["emoji", "like"] },
	{ id: "emoji-target", name: "Target", text: "\u{1F3AF}", keywords: ["emoji", "goal"] },
	{ id: "emoji-trophy", name: "Trophy", text: "\u{1F3C6}", keywords: ["emoji", "win"] },
	{ id: "emoji-gem", name: "Gem", text: "\u{1F48E}", keywords: ["emoji", "premium"] },
	{ id: "emoji-rocket", name: "Rocket", text: "\u{1F680}", keywords: ["emoji", "launch"] },
	{ id: "emoji-clock", name: "Clock", text: "\u{23F0}", keywords: ["emoji", "time"] },
	{ id: "emoji-money", name: "Money", text: "\u{1F4B8}", keywords: ["emoji", "cash"] },
	{ id: "emoji-gift", name: "Gift", text: "\u{1F381}", keywords: ["emoji", "present"] },
	{ id: "emoji-lock", name: "Lock", text: "\u{1F512}", keywords: ["emoji", "secure"] },
	{ id: "emoji-megaphone", name: "Megaphone", text: "\u{1F4E3}", keywords: ["emoji", "announce"] },
	{ id: "emoji-camera", name: "Camera", text: "\u{1F4F7}", keywords: ["emoji", "photo"] },
	{ id: "emoji-music", name: "Music", text: "\u{1F3B5}", keywords: ["emoji", "sound"] },
	{ id: "emoji-game", name: "Game", text: "\u{1F3AE}", keywords: ["emoji", "play"] },
];

const SYMBOL_STICKERS: BuiltinSticker[] = [
	{ id: "arrow-right", name: "Arrow Right", text: "\u{2192}", keywords: ["arrow", "right"], shape: "circle" },
	{ id: "arrow-left", name: "Arrow Left", text: "\u{2190}", keywords: ["arrow", "left"], shape: "circle" },
	{ id: "arrow-up", name: "Arrow Up", text: "\u{2191}", keywords: ["arrow", "up"], shape: "circle" },
	{ id: "arrow-down", name: "Arrow Down", text: "\u{2193}", keywords: ["arrow", "down"], shape: "circle" },
	{ id: "arrow-up-right", name: "Arrow Up Right", text: "\u{2197}", keywords: ["arrow", "trend"], shape: "circle" },
	{ id: "play-symbol", name: "Play", text: "\u{25B6}", keywords: ["play", "media"], shape: "circle" },
	{ id: "pause-symbol", name: "Pause", text: "\u{23F8}", keywords: ["pause", "media"], shape: "circle" },
	{ id: "plus-symbol", name: "Plus", text: "+", keywords: ["plus", "add"], shape: "circle" },
	{ id: "minus-symbol", name: "Minus", text: "-", keywords: ["minus", "remove"], shape: "circle" },
	{ id: "check-symbol", name: "Check Mark", text: "\u{2713}", keywords: ["check", "done"], shape: "circle", background: "#17c964" },
	{ id: "x-symbol", name: "X Mark", text: "\u{2715}", keywords: ["x", "close"], shape: "circle", background: "#f31260" },
	{ id: "info-symbol", name: "Info", text: "i", keywords: ["info", "help"], shape: "circle", background: "#1d9bf0" },
	{ id: "question-symbol", name: "Question", text: "?", keywords: ["question", "help"], shape: "circle", background: "#7c3aed" },
	{ id: "hashtag-symbol", name: "Hashtag", text: "#", keywords: ["hash", "tag"], shape: "square" },
	{ id: "at-symbol", name: "At Sign", text: "@", keywords: ["social", "mention"], shape: "square" },
	{ id: "percent-symbol", name: "Percent", text: "%", keywords: ["sale", "discount"], shape: "square", background: "#f59e0b" },
	{ id: "badge-new", name: "New Badge", text: "NEW", keywords: ["badge", "label"], shape: "pill", background: "#00e5ff" },
	{ id: "badge-hot", name: "Hot Badge", text: "HOT", keywords: ["badge", "label"], shape: "pill", background: "#ff3b30" },
	{ id: "badge-live", name: "Live Badge", text: "LIVE", keywords: ["badge", "stream"], shape: "pill", background: "#ff005c" },
	{ id: "badge-pro", name: "Pro Badge", text: "PRO", keywords: ["badge", "premium"], shape: "pill", background: "#8b5cf6" },
	{ id: "label-sale", name: "Sale Label", text: "SALE", keywords: ["sale", "tag"], shape: "burst", background: "#ffd60a", foreground: "#111827" },
	{ id: "label-wow", name: "Wow Burst", text: "WOW", keywords: ["wow", "burst"], shape: "burst", background: "#ff4d00" },
	{ id: "callout-yes", name: "Yes Callout", text: "YES!", keywords: ["callout", "yes"], shape: "callout", background: "#22c55e" },
	{ id: "callout-no", name: "No Callout", text: "NO!", keywords: ["callout", "no"], shape: "callout", background: "#ef4444" },
	{ id: "callout-tip", name: "Tip Callout", text: "TIP", keywords: ["callout", "tip"], shape: "callout", background: "#38bdf8" },
	{ id: "label-vip", name: "VIP Label", text: "VIP", keywords: ["label", "vip"], shape: "pill", background: "#111827" },
	{ id: "label-free", name: "Free Label", text: "FREE", keywords: ["label", "free"], shape: "pill", background: "#16a34a" },
	{ id: "label-soon", name: "Soon Label", text: "SOON", keywords: ["label", "soon"], shape: "pill", background: "#64748b" },
	{ id: "quote-open", name: "Quote Open", text: "\u{201C}", keywords: ["quote", "text"], shape: "plain" },
	{ id: "quote-close", name: "Quote Close", text: "\u{201D}", keywords: ["quote", "text"], shape: "plain" },
	{ id: "heart-symbol", name: "Heart", text: "\u{2665}", keywords: ["heart", "love"], shape: "circle", background: "#ff2d55" },
	{ id: "diamond-symbol", name: "Diamond", text: "\u{25C6}", keywords: ["diamond", "shape"], shape: "circle", background: "#06b6d4" },
	{ id: "spark-symbol", name: "Spark", text: "\u{2736}", keywords: ["spark", "star"], shape: "circle", background: "#9333ea" },
	{ id: "pin-symbol", name: "Pin", text: "\u{25CF}", keywords: ["pin", "dot"], shape: "circle", background: "#f97316" },
	{ id: "slash-symbol", name: "Slash", text: "/", keywords: ["slash", "divider"], shape: "square" },
	{ id: "equals-symbol", name: "Equals", text: "=", keywords: ["equals", "math"], shape: "square" },
	{ id: "brackets-symbol", name: "Brackets", text: "[ ]", keywords: ["brackets", "frame"], shape: "pill" },
	{ id: "code-symbol", name: "Code", text: "</>", keywords: ["code", "developer"], shape: "pill", background: "#0f172a" },
	{ id: "sound-wave", name: "Sound Wave", text: "\u{224B}", keywords: ["sound", "wave"], shape: "circle", background: "#0ea5e9" },
	{ id: "wifi-symbol", name: "Wifi", text: "\u{25DC}", keywords: ["wifi", "signal"], shape: "circle", background: "#14b8a6" },
];

const BUILTIN_STICKERS = [...EMOJI_STICKERS, ...SYMBOL_STICKERS];

function escapeSvgText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function buildBuiltinUrl({ sticker }: { sticker: BuiltinSticker }): string {
	const background = sticker.background ?? "#111827";
	const foreground = sticker.foreground ?? "#ffffff";
	const shape = sticker.shape ?? "plain";
	const fontSize = sticker.text.length > 4 ? 54 : sticker.text.length > 2 ? 72 : 104;
	const shapeSvg =
		shape === "circle"
			? `<circle cx="128" cy="128" r="112" fill="${background}" />`
			: shape === "square"
				? `<rect x="28" y="28" width="200" height="200" rx="34" fill="${background}" />`
				: shape === "pill"
					? `<rect x="16" y="72" width="224" height="112" rx="56" fill="${background}" />`
					: shape === "burst"
						? `<path d="M128 10l23 52 56-17-18 56 53 27-53 27 18 56-56-17-23 52-23-52-56 17 18-56-53-27 53-27-18-56 56 17z" fill="${background}" />`
						: shape === "callout"
							? `<path d="M28 58h200a18 18 0 0 1 18 18v92a18 18 0 0 1-18 18h-70l-30 38-30-38H28a18 18 0 0 1-18-18V76a18 18 0 0 1 18-18z" fill="${background}" />`
							: "";
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
		${shapeSvg}
		<text x="128" y="138" dominant-baseline="middle" text-anchor="middle" fill="${foreground}" font-size="${fontSize}" font-family="Inter, Arial, sans-serif" font-weight="800">${escapeSvgText(sticker.text)}</text>
	</svg>`;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function toStickerItem({ sticker }: { sticker: BuiltinSticker }): StickerItem {
	return {
		id: buildStickerId({
			providerId: BUILTINS_PROVIDER_ID,
			providerValue: sticker.id,
		}),
		provider: BUILTINS_PROVIDER_ID,
		name: sticker.name,
		previewUrl: buildBuiltinUrl({ sticker }),
		metadata: {
			keywords: sticker.keywords,
		},
	};
}

function findBuiltin({ stickerId }: { stickerId: string }): BuiltinSticker {
	const { providerValue } = parseStickerId({ stickerId });
	return (
		BUILTIN_STICKERS.find((sticker) => sticker.id === providerValue) ??
		BUILTIN_STICKERS[0]
	);
}

export const builtinStickersProvider: StickerProvider = {
	id: BUILTINS_PROVIDER_ID,
	async search({
		query,
		options,
	}: {
		query: string;
		options?: { limit?: number };
	}): Promise<StickerSearchResult> {
		const normalizedQuery = query.trim().toLowerCase();
		const filtered = BUILTIN_STICKERS.filter(
			(sticker) =>
				sticker.name.toLowerCase().includes(normalizedQuery) ||
				sticker.keywords.some((keyword) => keyword.includes(normalizedQuery)),
		);
		const limit = options?.limit ?? filtered.length;
		return {
			items: filtered.slice(0, limit).map((sticker) => toStickerItem({ sticker })),
			total: filtered.length,
			hasMore: filtered.length > limit,
		};
	},
	async browse({
		options,
	}: {
		options?: { page?: number; limit?: number };
	}): Promise<StickerBrowseResult> {
		const page = Math.max(1, options?.page ?? 1);
		const limit = Math.max(1, options?.limit ?? BUILTIN_STICKERS.length);
		const startIndex = (page - 1) * limit;
		const endIndex = startIndex + limit;
		return {
			sections: [
				{
					id: "all",
					items: BUILTIN_STICKERS.slice(startIndex, endIndex).map((sticker) =>
						toStickerItem({ sticker }),
					),
					hasMore: endIndex < BUILTIN_STICKERS.length,
					layout: "grid",
				},
			],
		};
	},
	resolveUrl({ stickerId }: { stickerId: string }): string {
		return buildBuiltinUrl({ sticker: findBuiltin({ stickerId }) });
	},
};
