import type { FrameRate } from "opencut-wasm";
import type {
	ElementRef,
	RetimeConfig,
	TextWordRun,
	TextElement,
} from "@/timeline/types";
import type { MediaTime } from "@/wasm";

export type ResizeSide = "left" | "right";

export interface GroupResizeMember extends ElementRef {
	startTime: MediaTime;
	duration: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
	sourceDuration?: MediaTime;
	retime?: RetimeConfig;
	leftNeighborBound: MediaTime | null;
	rightNeighborBound: MediaTime | null;
	ripple?: boolean;
}

export interface GroupResizeUpdate extends ElementRef {
	patch: {
		wordRuns?: TextWordRun[];
		params?: TextElement["params"];
		trimStart: MediaTime;
		trimEnd: MediaTime;
		startTime: MediaTime;
		duration: MediaTime;
	};
}

export interface GroupResizeResult {
	deltaTime: MediaTime;
	updates: GroupResizeUpdate[];
	timeEdit?: { cutTime: MediaTime; insertedDuration: MediaTime };
}

export interface ComputeGroupResizeArgs {
	members: GroupResizeMember[];
	side: ResizeSide;
	deltaTime: MediaTime;
	fps: FrameRate;
}
