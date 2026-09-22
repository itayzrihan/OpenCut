import { mock } from "bun:test";

mock.module("../ripple-resize-wasm", () => ({
	rippleResizeWasm: {
		rippleInsertTime: ({
			clips,
			cutTime,
			insertedDuration,
		}: {
			clips: Array<{ id: string; startTime: number; duration: number }>;
			cutTime: number;
			insertedDuration: number;
		}) =>
			clips.map((clip) => {
				if (insertedDuration < 0) {
					const start = Math.max(0, cutTime + insertedDuration);
					const map = (time: number) =>
						time <= start
							? time
							: time < cutTime
								? start
								: time - (cutTime - start);
					return {
						...clip,
						startTime: map(clip.startTime),
						duration: map(clip.startTime + clip.duration) - map(clip.startTime),
					};
				}
				if (clip.startTime >= cutTime) {
					return { ...clip, startTime: clip.startTime + insertedDuration };
				}
				if (clip.startTime + clip.duration > cutTime) {
					return { ...clip, duration: clip.duration + insertedDuration };
				}
				return clip;
			}),
	},
}));
