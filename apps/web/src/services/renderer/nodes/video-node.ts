import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";
import type {
	BackgroundRemovalSettings,
	ResolvedBackgroundRemovalSettings,
} from "@/background-removal";
import type { EffectPass } from "@/effects/types";
import type { BackgroundMaskFrame } from "@/services/background-removal";

export interface VideoNodeParams extends VisualNodeParams {
	url: string;
	file?: File;
	mediaId: string;
	backgroundRemoval?: BackgroundRemovalSettings;
	isPreview: boolean;
}

export interface ResolvedVideoNodeState extends ResolvedVisualSourceNodeState {
	backgroundRemoval?: {
		mask: BackgroundMaskFrame;
		settings: ResolvedBackgroundRemovalSettings;
		backgroundEffectPasses: EffectPass[][];
	};
}

export class VideoNode extends VisualNode<
	VideoNodeParams,
	ResolvedVideoNodeState
> {}
