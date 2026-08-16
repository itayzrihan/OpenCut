import type { AudioAnalysisFrame } from "opencut-wasm";

/**
 * GPU-accelerated audio feature extraction using WebGPU.
 * Processes multiple frames in parallel on the GPU, achieving large speedups
 * over the CPU implementation for long audio files.
 */

interface GPUContext {
	device: GPUDevice;
	queue: GPUQueue;
	computePipeline: GPUComputePipeline;
	bindGroupLayout: GPUBindGroupLayout;
}

let gpuContextPromise: Promise<GPUContext | null> | null = null;

// All params are stored as f32 (even integer-valued ones) so the JS side never
// has to bit-reinterpret an integer as a float across the buffer boundary; the
// shader converts back to u32 where indices are needed. Struct is padded to a
// multiple of 16 bytes as required for the uniform address space.
const AUDIO_ANALYSIS_SHADER = `
@group(0) @binding(0) var<storage, read> samples: array<f32>;
@group(0) @binding(1) var<storage, read_write> frames: array<AudioFrame>;
@group(0) @binding(2) var<uniform> params: AnalysisParams;

struct AudioFrame {
	start: f32,
	end: f32,
	rms: f32,
	peak: f32,
	zeroCrossingRate: f32,
	_pad0: f32,
}

struct AnalysisParams {
	frameSize: f32,
	firstSample: f32,
	finalSample: f32,
	sampleRate: f32,
	sourceStartSeconds: f32,
	playbackRate: f32,
	_pad0: f32,
	_pad1: f32,
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
	let frameIndex = global_id.x;
	let frameSize = u32(params.frameSize);
	let firstSample = u32(params.firstSample);
	let finalSample = u32(params.finalSample);
	let sampleRate = params.sampleRate;
	let sourceStartSeconds = params.sourceStartSeconds;
	let playbackRate = params.playbackRate;

	let frameStartSample = firstSample + frameIndex * frameSize;
	if (frameStartSample >= finalSample) {
		return;
	}

	let frameEndSample = min(finalSample, frameStartSample + frameSize);
	let sampleCount = frameEndSample - frameStartSample;

	var sumSquares: f32 = 0.0;
	var peak: f32 = 0.0;
	var zeroCrossings: u32 = 0u;
	var previous: f32 = samples[frameStartSample];

	for (var i: u32 = frameStartSample; i < frameEndSample; i = i + 1u) {
		let sample = samples[i];
		sumSquares = sumSquares + sample * sample;
		peak = max(peak, abs(sample));

		if (i > frameStartSample) {
			let wasBelowZero = previous < 0.0;
			let isAboveZero = sample >= 0.0;
			let crossedZero = (wasBelowZero && isAboveZero) || (!wasBelowZero && !isAboveZero);
			if (crossedZero) {
				zeroCrossings = zeroCrossings + 1u;
			}
		}
		previous = sample;
	}

	let sourceFrameStart = f32(frameStartSample) / sampleRate;
	let sourceFrameEnd = f32(frameEndSample) / sampleRate;
	let rms = sqrt(sumSquares / f32(max(1u, sampleCount)));
	let zcr = select(0.0, f32(zeroCrossings) / f32(max(1u, sampleCount - 1u)), sampleCount > 1u);

	frames[frameIndex].start = max(0.0, (sourceFrameStart - sourceStartSeconds) / playbackRate);
	frames[frameIndex].end = max(0.0, (sourceFrameEnd - sourceStartSeconds) / playbackRate);
	frames[frameIndex].rms = rms;
	frames[frameIndex].peak = peak;
	frames[frameIndex].zeroCrossingRate = zcr;
}
`;

async function createGPUContext(): Promise<GPUContext | null> {
	try {
		if (!navigator.gpu) {
			console.warn("[GPU Audio] WebGPU is not available in this runtime");
			return null;
		}

		const adapter = await navigator.gpu.requestAdapter();
		if (!adapter) {
			console.warn("[GPU Audio] No WebGPU adapter available");
			return null;
		}
		console.log("[GPU Audio] Adapter acquired:", adapter.info ?? "(no adapter info)");

		const device = await adapter.requestDevice();
		device.addEventListener("uncapturederror", (event) => {
			console.error("[GPU Audio] Uncaptured WebGPU error:", event.error.message);
		});

		device.pushErrorScope("validation");

		const bindGroupLayout = device.createBindGroupLayout({
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "storage" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "uniform" },
				},
			],
		});

		const shaderModule = device.createShaderModule({ code: AUDIO_ANALYSIS_SHADER });
		const compilationInfo = await shaderModule.getCompilationInfo();
		const shaderErrors = compilationInfo.messages.filter((m) => m.type === "error");
		if (shaderErrors.length > 0) {
			console.error(
				"[GPU Audio] Shader compilation errors:",
				shaderErrors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`),
			);
			await device.popErrorScope();
			return null;
		}

		const computePipeline = device.createComputePipeline({
			layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
			compute: { module: shaderModule, entryPoint: "main" },
		});

		const validationError = await device.popErrorScope();
		if (validationError) {
			console.error("[GPU Audio] Pipeline creation failed:", validationError.message);
			return null;
		}

		console.log("[GPU Audio] WebGPU pipeline ready");
		return { device, queue: device.queue, computePipeline, bindGroupLayout };
	} catch (error) {
		console.warn("[GPU Audio] WebGPU initialization failed, falling back to CPU:", error);
		return null;
	}
}

function getGPUContext(): Promise<GPUContext | null> {
	if (!gpuContextPromise) {
		console.log("[GPU Audio] Initializing WebGPU...");
		gpuContextPromise = createGPUContext();
	}
	return gpuContextPromise;
}

async function runOnCPU(options: {
	samples: Float32Array;
	sampleRate: number;
	sourceStartSeconds: number;
	sourceEndSeconds: number;
	playbackRate: number;
	frameDurationSeconds: number;
	yieldEveryFrames: number;
	yieldControl: () => Promise<void>;
}): Promise<AudioAnalysisFrame[]> {
	const { extractCompactAudioFeatures } = await import("./audio-silence-analysis");
	return extractCompactAudioFeatures(options);
}

/**
 * GPU-accelerated audio feature extraction. Falls back to CPU if WebGPU is
 * unavailable or the shader fails to compile/validate on this device.
 */
export async function extractCompactAudioFeaturesGPU({
	samples,
	sampleRate,
	sourceStartSeconds,
	sourceEndSeconds,
	playbackRate,
	frameDurationSeconds = 0.02,
	yieldEveryFrames = 400,
	yieldControl = yieldToBrowser,
}: {
	samples: Float32Array;
	sampleRate: number;
	sourceStartSeconds: number;
	sourceEndSeconds: number;
	playbackRate: number;
	frameDurationSeconds?: number;
	yieldEveryFrames?: number;
	yieldControl?: () => Promise<void>;
}): Promise<AudioAnalysisFrame[]> {
	if (
		!Number.isFinite(sampleRate) ||
		sampleRate <= 0 ||
		!Number.isFinite(sourceStartSeconds) ||
		!Number.isFinite(sourceEndSeconds) ||
		sourceEndSeconds <= sourceStartSeconds ||
		!Number.isFinite(playbackRate) ||
		playbackRate <= 0 ||
		!Number.isFinite(frameDurationSeconds) ||
		frameDurationSeconds <= 0 ||
		samples.length === 0
	) {
		return [];
	}

	const cpuOptions = {
		samples,
		sampleRate,
		sourceStartSeconds,
		sourceEndSeconds,
		playbackRate,
		frameDurationSeconds,
		yieldEveryFrames,
		yieldControl,
	};

	const gpuContext = await getGPUContext();
	if (!gpuContext) {
		console.log("[GPU Audio] GPU unavailable, using CPU audio analysis");
		return runOnCPU(cpuOptions);
	}

	const firstSample = Math.max(
		0,
		Math.min(samples.length, Math.floor(sourceStartSeconds * sampleRate)),
	);
	const finalSample = Math.max(
		firstSample,
		Math.min(samples.length, Math.ceil(sourceEndSeconds * sampleRate)),
	);
	const frameSize = Math.max(1, Math.round(sampleRate * frameDurationSeconds));
	const frameCount = Math.ceil((finalSample - firstSample) / frameSize);

	if (frameCount === 0) return [];

	console.log(
		`[GPU Audio] Processing ${frameCount} frames on GPU (frame size: ${frameSize} samples, ${samples.length} total samples)`,
	);

	const { device, queue } = gpuContext;

	try {
		device.pushErrorScope("validation");

		const samplesBuffer = device.createBuffer({
			size: Math.max(4, samples.byteLength),
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			mappedAtCreation: true,
		});
		new Float32Array(samplesBuffer.getMappedRange()).set(samples);
		samplesBuffer.unmap();

		// AudioFrame struct = 6 x f32 = 24 bytes.
		const FRAME_STRUCT_FLOATS = 6;
		const framesBuffer = device.createBuffer({
			size: frameCount * FRAME_STRUCT_FLOATS * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
		});

		// AnalysisParams struct = 8 x f32 = 32 bytes (padded to multiple of 16).
		const paramsBuffer = device.createBuffer({
			size: 32,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			mappedAtCreation: true,
		});
		new Float32Array(paramsBuffer.getMappedRange()).set([
			frameSize,
			firstSample,
			finalSample,
			sampleRate,
			sourceStartSeconds,
			playbackRate,
			0,
			0,
		]);
		paramsBuffer.unmap();

		const bindGroup = device.createBindGroup({
			layout: gpuContext.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: samplesBuffer } },
				{ binding: 1, resource: { buffer: framesBuffer } },
				{ binding: 2, resource: { buffer: paramsBuffer } },
			],
		});

		const startTime = performance.now();
		const commandEncoder = device.createCommandEncoder();
		const passEncoder = commandEncoder.beginComputePass();
		passEncoder.setPipeline(gpuContext.computePipeline);
		passEncoder.setBindGroup(0, bindGroup);
		const workgroups = Math.ceil(frameCount / 64);
		passEncoder.dispatchWorkgroups(workgroups);
		passEncoder.end();

		const stagingBuffer = device.createBuffer({
			size: frameCount * FRAME_STRUCT_FLOATS * 4,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});
		commandEncoder.copyBufferToBuffer(framesBuffer, 0, stagingBuffer, 0, stagingBuffer.size);
		queue.submit([commandEncoder.finish()]);

		await stagingBuffer.mapAsync(GPUMapMode.READ);
		const frameData = new Float32Array(stagingBuffer.getMappedRange()).slice();
		stagingBuffer.unmap();

		const validationError = await device.popErrorScope();
		if (validationError) {
			console.error(
				"[GPU Audio] GPU execution failed, falling back to CPU:",
				validationError.message,
			);
			samplesBuffer.destroy();
			framesBuffer.destroy();
			paramsBuffer.destroy();
			stagingBuffer.destroy();
			return runOnCPU(cpuOptions);
		}

		const gpuTime = performance.now() - startTime;
		console.log(
			`[GPU Audio] GPU compute completed in ${gpuTime.toFixed(2)}ms (${workgroups} workgroups, ${frameCount} frames)`,
		);

		const frames: AudioAnalysisFrame[] = [];
		for (let i = 0; i < frameCount; i++) {
			const offset = i * FRAME_STRUCT_FLOATS;
			frames.push({
				start: frameData[offset],
				end: frameData[offset + 1],
				rms: frameData[offset + 2],
				peak: frameData[offset + 3],
				zeroCrossingRate: frameData[offset + 4],
			});
		}

		samplesBuffer.destroy();
		framesBuffer.destroy();
		paramsBuffer.destroy();
		stagingBuffer.destroy();

		for (let i = 0; i < frameCount; i += yieldEveryFrames) {
			if (i > 0) await yieldControl();
		}

		return frames;
	} catch (error) {
		console.error("[GPU Audio] GPU execution threw, falling back to CPU:", error);
		return runOnCPU(cpuOptions);
	}
}

async function yieldToBrowser(): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
}
