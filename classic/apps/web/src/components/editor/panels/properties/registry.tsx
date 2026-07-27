import type { ReactNode } from "react";
import type {
	EffectElement,
	GraphicElement,
	ImageElement,
	MaskableElement,
	RetimableElement,
	StickerElement,
	TextElement,
	VisualElement,
	VideoElement,
	AudioElement,
	TimelineElement,
} from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	TextFontIcon,
	ArrowExpandIcon,
	RainDropIcon,
	MusicNote03Icon,
	MagicWand05Icon,
	DashboardSpeed02Icon,
	TransitionTopIcon,
	GridViewIcon,
} from "@hugeicons/core-free-icons";
import { ElementParamsTab } from "./components/element-params-tab";
import type { ElementWithTrackForParams } from "./components/element-params-tab";
import {
	ClipEffectsTab,
	StandaloneEffectTab,
} from "@/effects/components/effects-tab";
import { MasksTab } from "@/masks/components/masks-tab";
import { SpeedTab } from "@/speed/components/speed-tab";
import { GraphicTab } from "@/graphics/components/graphic-tab";
import { UI_ELEMENT_GRAPHIC_ID } from "@/graphics/definitions/ui-element";
import { UiElementPropertiesTab } from "@/ui-elements/components/properties-tab";
import { OcShapesIcon } from "@/components/icons";
import { TextTransitionsTab } from "./components/text-transitions-tab";
import { TextWordsTab } from "./components/text-words-tab";
import { TextPlacementTab } from "./components/text-placement-tab";
import type { TextOverrideScope } from "./text-scope";
import { BackgroundRemovalTab } from "./components/background-removal-tab";

const TRANSFORM_PARAM_KEYS = [
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
	"transform.rotate",
	"transform.perspectiveX",
	"transform.perspectiveY",
] as const;

const BLENDING_PARAM_KEYS = ["opacity", "blendMode"] as const;
const AUDIO_PARAM_KEYS = [
	"volume",
	"muted",
	"fadeInDuration",
	"fadeOutDuration",
] as const;
const TEXT_PARAM_KEYS = [
	"content",
	"fontFamily",
	"fontSize",
	"color",
	"textFillMode",
	"gradientStartColor",
	"gradientEndColor",
	"gradientAngle",
	"textAlign",
	"fontWeight",
	"fontStyle",
	"textDecoration",
	"letterSpacing",
	"lineHeight",
	"stroke.enabled",
	"stroke.color",
	"stroke.width",
	"shadow.enabled",
	"shadow.color",
	"shadow.blur",
	"shadow.offsetX",
	"shadow.offsetY",
	"background.enabled",
	"background.color",
	"background.cornerRadius",
	"background.paddingX",
	"background.paddingY",
	"background.offsetX",
	"background.offsetY",
] as const;

export type TabContentProps = {
	trackId: string;
	elementsWithTracks?: ElementWithTrackForParams[];
	textScope?: TextOverrideScope;
};

export type PropertiesTabDef = {
	id: string;
	label: string;
	icon: ReactNode;
	content: (props: TabContentProps) => ReactNode;
};

export type ElementPropertiesConfig = {
	defaultTab: string;
	tabs: PropertiesTabDef[];
};

function buildTransformTab({
	element,
}: {
	element: VisualElement;
}): PropertiesTabDef {
	return {
		id: "transform",
		label: "Transform",
		icon: <HugeiconsIcon icon={ArrowExpandIcon} size={16} />,
		content: ({ trackId, elementsWithTracks, textScope }) => (
			<ElementParamsTab
				element={element}
				trackId={trackId}
				elementsWithTracks={elementsWithTracks}
				paramKeys={TRANSFORM_PARAM_KEYS}
				sectionKey="transform"
				textScope={textScope}
			/>
		),
	};
}

function buildBlendingTab({
	element,
}: {
	element: VisualElement;
}): PropertiesTabDef {
	return {
		id: "blending",
		label: "Blending",
		icon: <HugeiconsIcon icon={RainDropIcon} size={16} />,
		content: ({ trackId, elementsWithTracks, textScope }) => (
			<ElementParamsTab
				element={element}
				trackId={trackId}
				elementsWithTracks={elementsWithTracks}
				paramKeys={BLENDING_PARAM_KEYS}
				sectionKey="blending"
				textScope={textScope}
			/>
		),
	};
}

function buildAudioTab({
	element,
}: {
	element: AudioElement | VideoElement;
}): PropertiesTabDef {
	return {
		id: "audio",
		label: "Audio",
		icon: <HugeiconsIcon icon={MusicNote03Icon} size={16} />,
		content: ({ trackId, elementsWithTracks }) => (
			<ElementParamsTab
				element={element}
				trackId={trackId}
				elementsWithTracks={elementsWithTracks}
				paramKeys={AUDIO_PARAM_KEYS}
				sectionKey="audio"
			/>
		),
	};
}

function buildSpeedTab({
	element,
}: {
	element: RetimableElement;
}): PropertiesTabDef {
	return {
		id: "speed",
		label: "Speed",
		icon: <HugeiconsIcon icon={DashboardSpeed02Icon} size={16} />,
		content: ({ trackId }) => <SpeedTab element={element} trackId={trackId} />,
	};
}

function buildBackgroundRemovalTab({
	element,
}: {
	element: VideoElement;
}): PropertiesTabDef {
	return {
		id: "background-removal",
		label: "Background",
		icon: <HugeiconsIcon icon={MagicWand05Icon} size={16} />,
		content: ({ trackId }) => (
			<BackgroundRemovalTab element={element} trackId={trackId} />
		),
	};
}

function buildMasksTab({
	element,
}: {
	element: MaskableElement;
}): PropertiesTabDef {
	return {
		id: "masks",
		label: "Masks",
		icon: <OcShapesIcon size={16} />,
		content: ({ trackId }) => <MasksTab element={element} trackId={trackId} />,
	};
}

function buildClipEffectsTab({
	element,
}: {
	element: VisualElement;
}): PropertiesTabDef {
	return {
		id: "effects",
		label: "Effects",
		icon: <HugeiconsIcon icon={MagicWand05Icon} size={16} />,
		content: ({ trackId }) => (
			<ClipEffectsTab element={element} trackId={trackId} />
		),
	};
}

function buildTextTab({ element }: { element: TextElement }): PropertiesTabDef {
	return {
		id: "text",
		label: "Text",
		icon: <HugeiconsIcon icon={TextFontIcon} size={16} />,
		content: ({ trackId, elementsWithTracks, textScope }) => (
			<ElementParamsTab
				element={element}
				trackId={trackId}
				elementsWithTracks={elementsWithTracks}
				paramKeys={TEXT_PARAM_KEYS}
				sectionKey="text"
				textScope={textScope}
			/>
		),
	};
}

function buildTextTransitionsTab({
	element,
}: {
	element: TextElement;
}): PropertiesTabDef {
	return {
		id: "transitions",
		label: "Transitions",
		icon: <HugeiconsIcon icon={TransitionTopIcon} size={16} />,
		content: ({ trackId, elementsWithTracks, textScope }) => (
			<TextTransitionsTab
				element={element}
				trackId={trackId}
				elementsWithTracks={elementsWithTracks}
				textScope={textScope}
			/>
		),
	};
}

function buildTextWordsTab({
	element,
}: {
	element: TextElement;
}): PropertiesTabDef {
	return {
		id: "words",
		label: "Words",
		icon: <HugeiconsIcon icon={TextFontIcon} size={16} />,
		content: ({ trackId, elementsWithTracks, textScope }) => (
			<TextWordsTab
				element={element}
				trackId={trackId}
				elementsWithTracks={elementsWithTracks}
				textScope={textScope}
			/>
		),
	};
}

function buildTextPlacementTab({
	element,
}: {
	element: TextElement;
}): PropertiesTabDef {
	return {
		id: "placement",
		label: "Placement",
		icon: <HugeiconsIcon icon={GridViewIcon} size={16} />,
		content: ({ trackId, elementsWithTracks, textScope }) => (
			<TextPlacementTab
				element={element}
				trackId={trackId}
				elementsWithTracks={elementsWithTracks}
				textScope={textScope}
			/>
		),
	};
}

function buildGraphicTab({
	element,
}: {
	element: GraphicElement;
}): PropertiesTabDef {
	const isUiElement = element.definitionId === UI_ELEMENT_GRAPHIC_ID;
	return {
		id: "graphic",
		label: isUiElement ? "UI" : "Graphic",
		icon: <OcShapesIcon size={16} />,
		content: ({ trackId }) =>
			isUiElement ? (
				<UiElementPropertiesTab element={element} trackId={trackId} />
			) : (
				<GraphicTab element={element} trackId={trackId} />
			),
	};
}

function buildStandaloneEffectTab({
	element,
}: {
	element: EffectElement;
}): PropertiesTabDef {
	return {
		id: "effects",
		label: "Effects",
		icon: <HugeiconsIcon icon={MagicWand05Icon} size={16} />,
		content: ({ trackId }) => (
			<StandaloneEffectTab element={element} trackId={trackId} />
		),
	};
}

function getTextConfig({
	element,
}: {
	element: TextElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "text",
		tabs: [
			buildTextTab({ element }),
			buildTextPlacementTab({ element }),
			buildTextWordsTab({ element }),
			buildTextTransitionsTab({ element }),
			buildTransformTab({ element }),
			buildBlendingTab({ element }),
		],
	};
}

function getVideoConfig({
	element,
	mediaAsset,
}: {
	element: VideoElement;
	mediaAsset: MediaAsset | undefined;
}): ElementPropertiesConfig {
	const showAudioTab = mediaAsset?.hasAudio !== false;
	return {
		defaultTab: "transform",
		tabs: [
			buildTransformTab({ element }),
			buildBackgroundRemovalTab({ element }),
			...(showAudioTab ? [buildAudioTab({ element })] : []),
			buildSpeedTab({ element }),
			buildBlendingTab({ element }),
			buildMasksTab({ element }),
			buildClipEffectsTab({ element }),
		],
	};
}

function getImageConfig({
	element,
}: {
	element: ImageElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "transform",
		tabs: [
			buildTransformTab({ element }),
			buildBlendingTab({ element }),
			buildMasksTab({ element }),
			buildClipEffectsTab({ element }),
		],
	};
}

function getStickerConfig({
	element,
}: {
	element: StickerElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "transform",
		tabs: [
			buildTransformTab({ element }),
			buildBlendingTab({ element }),
			buildClipEffectsTab({ element }),
		],
	};
}

function getGraphicConfig({
	element,
}: {
	element: GraphicElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "graphic",
		tabs: [
			buildGraphicTab({ element }),
			buildTransformTab({ element }),
			buildBlendingTab({ element }),
			buildMasksTab({ element }),
			buildClipEffectsTab({ element }),
		],
	};
}

function getAudioConfig({
	element,
}: {
	element: AudioElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "audio",
		tabs: [buildAudioTab({ element }), buildSpeedTab({ element })],
	};
}

function getEffectConfig({
	element,
}: {
	element: EffectElement;
}): ElementPropertiesConfig {
	return {
		defaultTab: "effects",
		tabs: [buildStandaloneEffectTab({ element })],
	};
}

export function getPropertiesConfig({
	element,
	mediaAssets,
}: {
	element: TimelineElement;
	mediaAssets: MediaAsset[];
}): ElementPropertiesConfig {
	switch (element.type) {
		case "text":
			return getTextConfig({ element });
		case "video": {
			const mediaAsset = mediaAssets.find((a) => a.id === element.mediaId);
			return getVideoConfig({ element, mediaAsset });
		}
		case "image":
			return getImageConfig({ element });
		case "sticker":
			return getStickerConfig({ element });
		case "graphic":
			return getGraphicConfig({ element });
		case "audio":
			return getAudioConfig({ element });
		case "effect":
			return getEffectConfig({ element });
	}
}
