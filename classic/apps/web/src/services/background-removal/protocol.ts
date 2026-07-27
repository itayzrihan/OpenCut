export type BackgroundRemovalBackend = "webgpu" | "wasm";

export type BackgroundRemovalWorkerMessage =
	| { type: "init" }
	| {
			type: "segment";
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
	| { type: "model-progress"; progress: number }
	| { type: "model-ready"; backend: BackgroundRemovalBackend }
	| { type: "model-error"; error: string }
	| {
			type: "segment-complete";
			requestId: number;
			width: number;
			height: number;
			rgba: Uint8ClampedArray;
	  }
	| { type: "segment-error"; requestId: number; error: string };
