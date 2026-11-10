import { DbsSpectrum } from "opencut-wasm";

const bins = 1025;
const hop = 512;
const chunk = 6 * 44_100;
const stride = chunk / 2;
const root = "/browser-models/dbs/";

type Tensor = { data: Float32Array; dispose(): void };
type Ort = {
	env: { wasm: { wasmPaths: string; numThreads: number } };
	Tensor: new (type: "float32", data: Float32Array, dims: number[]) => Tensor;
	InferenceSession: {
		create(
			model: string,
			options: { executionProviders: string[] },
		): Promise<{
			run(input: { spectrum: Tensor }): Promise<{ stems: Tensor }>;
			release(): Promise<void>;
		}>;
	};
};

async function separate(channels: [Float32Array, Float32Array]) {
	for (const channel of channels) {
		for (let i = 0; i < channel.length; i++) {
			if (!Number.isFinite(channel[i])) channel[i] = 0;
		}
	}
	const length = channels[0].length;
	const output = Array.from(
		{ length: 3 },
		() => [new Float32Array(length), new Float32Array(length)] as const,
	);
	if (channels.every((channel) => !channel.some(Boolean))) return output;
	const ort: Ort = await import(
		/* webpackIgnore: true */ `${root}ort.wasm.min.mjs`
	);
	ort.env.wasm.wasmPaths = new URL("/onnxruntime/", self.location.href).href;
	ort.env.wasm.numThreads = 1;
	const session = await ort.InferenceSession.create(`${root}dbs-tiger.onnx`, {
		executionProviders: ["wasm"],
	});
	const fft = new DbsSpectrum();
	try {
		const same = channels[0].every((sample, i) => sample === channels[1][i]);
		const weights = new Uint8Array(length);
		for (let start = 0; start < length; start += stride) {
			const valid = Math.min(length - start, chunk);
			const size =
				start === 0 && length > stride && length < chunk ? valid : chunk;
			for (let channel = 0; channel < (same ? 1 : 2); channel++) {
				const input = new Float32Array(size);
				input.set(channels[channel].subarray(start, start + valid));
				if (!input.some(Boolean)) continue;
				const tensor = new ort.Tensor("float32", fft.analyze(input), [
					1,
					2,
					bins,
					Math.floor(size / hop) + 1,
				]);
				try {
					const { stems } = await session.run({ spectrum: tensor });
					try {
						const waveform = fft.synthesize(stems.data, size);
						if (
							waveform.length !== 3 * size ||
							!waveform.every(Number.isFinite)
						)
							throw new Error("DBS-TIGER returned invalid audio");
						for (let stem = 0; stem < 3; stem++) {
							for (let i = 0; i < valid; i++)
								output[stem][channel][start + i] += waveform[stem * size + i];
						}
					} finally {
						stems.dispose();
					}
				} finally {
					tensor.dispose();
				}
			}
			for (let i = start; i < start + valid; i++) weights[i]++;
			self.postMessage({ progress: (start + valid) / length });
			if (start + chunk >= length) break;
		}
		for (const [left, right] of output) {
			for (let i = 0; i < length; i++) {
				left[i] /= weights[i];
				right[i] = same ? left[i] : right[i] / weights[i];
			}
		}
		return output;
	} finally {
		fft.free();
		await session.release();
	}
}

self.onmessage = async ({
	data,
}: MessageEvent<[Float32Array, Float32Array]>) => {
	try {
		const stems = await separate(data);
		self.postMessage(
			{ stems },
			{ transfer: stems.flat().map(({ buffer }) => buffer) },
		);
	} catch (error) {
		self.postMessage({
			error: error instanceof Error ? error.message : String(error),
		});
	}
};
