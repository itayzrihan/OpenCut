import { create } from "zustand";
import type { CameraManSample } from "./camera-man";
import type { MediaTime } from "@/wasm";

type CameraManPhase = "idle" | "recording" | "review";

interface CameraManState {
	phase: CameraManPhase;
	sceneId: string | null;
	current: Omit<CameraManSample, "time"> | null;
	samples: CameraManSample[];
	start: ({ sceneId, sample }: { sceneId: string; sample: CameraManSample }) => void;
	record: ({ time, x, y, scale }: CameraManSample) => void;
	stop: () => void;
	reset: () => void;
}

export const useCameraManStore = create<CameraManState>((set) => ({
	phase: "idle",
	sceneId: null,
	current: null,
	samples: [],
	start: ({ sceneId, sample }) =>
		set({
			phase: "recording",
			sceneId,
			current: { x: sample.x, y: sample.y, scale: sample.scale },
			samples: [sample],
		}),
	record: (sample) =>
		set((state) => {
			if (state.phase !== "recording") return state;
			const nextSamples = state.samples.slice();
			const last = nextSamples.at(-1);
			if (last?.time === sample.time) {
				nextSamples[nextSamples.length - 1] = sample;
			} else {
				nextSamples.push(sample);
			}
			return {
				current: { x: sample.x, y: sample.y, scale: sample.scale },
				samples: nextSamples,
			};
		}),
	stop: () => set((state) => ({ ...state, phase: "review" })),
	reset: () => set({ phase: "idle", sceneId: null, current: null, samples: [] }),
}));

export function recordCameraManSample({
	time,
	x,
	y,
	scale,
}: {
	time: MediaTime;
	x: number;
	y: number;
	scale: number;
}) {
	useCameraManStore.getState().record({ time, x, y, scale });
}

