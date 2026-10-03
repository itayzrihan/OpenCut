import type { TranscriptionModel, TranscriptionModelId } from "./types";

// Community ONNX conversions of ivrit-ai's weights, with cross-attention outputs
// required for word timing. Pin revisions; never execute remote Python/model code.
export const BROWSER_WHISPER_MODEL =
	"instush/ivrit-whisper-large-v3-turbo-timestamped-onnx";
export const BROWSER_WHISPER_REVISION =
	"c71eadaca74c0923a06632bdaeb7413ff9cff4cf";
export const BROWSER_WHISPER_CPU_MODEL =
	"krivlin/whisper-large-v3-turbo-ivrit-ai-timestamped-onnx";
export const BROWSER_WHISPER_CPU_REVISION =
	"af7e6de7bb1210105c8176f79236bd7c69e73002";

export const TRANSCRIPTION_MODELS: TranscriptionModel[] = [
	{
		id: "whisper-tiny",
		name: "Tiny",
		huggingFaceId: "onnx-community/whisper-tiny",
		description: "Fastest, lower accuracy",
	},
	{
		id: "whisper-small",
		name: "Small",
		huggingFaceId: "onnx-community/whisper-small",
		description: "Good balance of speed and accuracy",
	},
	{
		id: "whisper-medium",
		name: "Medium",
		huggingFaceId: "onnx-community/whisper-medium",
		description: "Higher accuracy, slower",
	},
	{
		id: "whisper-large-v3-turbo",
		name: "Large v3 Turbo",
		huggingFaceId: "onnx-community/whisper-large-v3-turbo",
		description: "Best accuracy, requires WebGPU for good performance",
	},
];

export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModelId =
	"whisper-small";
