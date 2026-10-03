import type { AgentTaskState } from "opencut-wasm";

export function getAutoTextsTranscriptionError({
	task,
}: {
	task: Pick<AgentTaskState, "status" | "error">;
}): string | null {
	if (task.status === "succeeded") return null;
	if (task.status === "cancelled") return "Transcription was cancelled.";
	return task.error?.trim() || "Transcript generation did not complete.";
}
