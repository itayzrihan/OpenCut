import { useEditorPlayback } from "@/editor/use-editor";
import { getElementLocalTime } from "@/animation";
import { addMediaTime, mediaTime, type MediaTime } from "@/wasm";

export function useElementPlayhead({
	startTime,
	duration,
	enabled = true,
}: {
	startTime: MediaTime;
	duration: MediaTime;
	enabled?: boolean;
}) {
	const playheadTime = useEditorPlayback((editor) =>
		enabled ? editor.playback.getCurrentTime() : startTime,
	);
	const localTime = mediaTime({
		ticks: getElementLocalTime({
			timelineTime: playheadTime,
			elementStartTime: startTime,
			elementDuration: duration,
		}),
	});
	const isPlayheadWithinElementRange =
		playheadTime >= startTime &&
		playheadTime <= addMediaTime({ a: startTime, b: duration });

	return { localTime, isPlayheadWithinElementRange };
}
