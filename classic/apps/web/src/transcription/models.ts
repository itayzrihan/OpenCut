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

export const BROWSER_TRANSCRIPTION_MODELS = [
	"ivrit-large-v3-turbo",
	"whisper-large-v3-turbo",
] as const;

export type BrowserTranscriptionModel =
	(typeof BROWSER_TRANSCRIPTION_MODELS)[number];

export const DEFAULT_BROWSER_TRANSCRIPTION_MODEL =
	BROWSER_TRANSCRIPTION_MODELS[0];

export const BROWSER_TRANSCRIPTION_LABELS: Record<
	BrowserTranscriptionModel,
	string
> = {
	"ivrit-large-v3-turbo": "ivrit.ai Large v3 Turbo",
	"whisper-large-v3-turbo": "Whisper Large v3 Turbo",
};

export const MULTILINGUAL_WHISPER_MODEL =
	"onnx-community/whisper-large-v3-turbo_timestamped";
export const MULTILINGUAL_WHISPER_REVISION =
	"b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a";

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
