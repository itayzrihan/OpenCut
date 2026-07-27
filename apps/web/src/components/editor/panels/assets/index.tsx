"use client";

import { Separator } from "@/components/ui/separator";
import {
	type Tab,
	useAssetsPanelStore,
} from "@/components/editor/panels/assets/assets-panel-store";
import { TabBar } from "./tabbar";
import { Captions } from "@/subtitles/components/assets-view";
import { CaptionReviewView } from "@/subtitles/components/caption-review-view";
import { MediaView } from "./views/assets";
import { SettingsView } from "./views/settings";
import { SoundsView } from "@/sounds/components/assets-view";
import { StickersView } from "@/stickers/components/assets-view";
import { UiElementsView } from "@/ui-elements/components/assets-view";
import { TextView } from "@/text/components/assets-view";
import { EffectsView } from "@/effects/components/assets-view";
import { BackgroundsView } from "@/backgrounds/components/assets-view";
import { OverlayEffectsView } from "@/effects/components/overlay-assets-view";
import { OverlayMovementView } from "@/effects/components/overlay-movement-assets-view";
import { TransitionsView } from "@/transitions/components/assets-view";
import { AiChatView } from "@/ai/components/ai-chat-view";
import { TimelineCodeView } from "@/ai/components/timeline-code-view";

export function AssetsPanel() {
	const { activeTab } = useAssetsPanelStore();

	const viewMap: Record<Tab, React.ReactNode> = {
		media: <MediaView />,
		ai: <AiChatView />,
		"timeline-code": <TimelineCodeView />,
		sounds: <SoundsView />,
		text: <TextView />,
		stickers: <StickersView />,
		"ui-elements": <UiElementsView />,
		backgrounds: <BackgroundsView />,
		effects: <EffectsView />,
		overlays: <OverlayEffectsView />,
		"overlay-movement": <OverlayMovementView />,
		transitions: <TransitionsView />,
		captions: <Captions />,
		"see-captions": <CaptionReviewView />,
		adjustment: (
			<div className="text-muted-foreground p-4">
				Adjustment view coming soon...
			</div>
		),
		settings: <SettingsView />,
	};

	return (
		<div className="panel bg-background flex h-full rounded-sm border overflow-hidden">
			<TabBar />
			<Separator orientation="vertical" />
			<div className="flex-1 overflow-hidden">{viewMap[activeTab]}</div>
		</div>
	);
}
