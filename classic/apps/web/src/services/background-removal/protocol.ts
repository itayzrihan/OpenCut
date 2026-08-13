export type BackgroundRemovalBackend = "webgpu" | "wasm";

export type BackgroundRemovalWorkerMessage =
	| {
			type: "init";
			generation: number;
			backend?: "auto" | BackgroundRemovalBackend;
	  }
	| { type: "cancel"; generation: number; requestId: number }
	| {
			type: "segment";
			generation: number;
			requestId: number;
			bitmap: ImageBitmap;
			mediaId: string;
			sourceTime: number;
			sequenceKey: string;
			inputSize: number;
			maskThreshold: number;
			edgeContrast: number;
			temporalSmoothing: number;
	  };

export type BackgroundRemovalWorkerResponse =
	| { type: "model-progress"; generation: number; progress: number }
	| {
			type: "model-ready";
			generation: number;
			backend: BackgroundRemovalBackend;
	  }
	| { type: "model-error"; generation: number; error: string }
	| {
			type: "segment-complete";
			generation: number;
			requestId: number;
			width: number;
			height: number;
			alpha: Uint8Array;
	  }
	| {
			type: "segment-error";
			generation: number;
			requestId: number;
			error: string;
	  };
