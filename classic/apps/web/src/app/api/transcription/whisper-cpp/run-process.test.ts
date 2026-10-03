import { expect, test } from "bun:test";
import { runProcess, WHISPER_GPU_BACKEND_PATTERN } from "./run-process";

test("recognizes active Apple Metal backends without accepting CPU fallback", () => {
	for (const backend of ["Metal", "MTL0", "MTL1", "CUDA0", "Vulkan0", "SYCL0"]) {
		expect(WHISPER_GPU_BACKEND_PATTERN.test(`whisper_backend_init_gpu: using ${backend} backend`)).toBe(true);
	}
	for (const line of ["using CPU backend", "using BLAS backend", "loaded MTL backend", "found GPU device 1: MTL0"]) {
		expect(WHISPER_GPU_BACKEND_PATTERN.test(line)).toBe(false);
	}
});

test("GPU requirement survives split output and later log truncation", async () => {
	await runProcess({
		command: process.execPath,
		args: [
			"-e",
			"process.stderr.write('using CU'); setTimeout(() => { process.stderr.write('DA0 backend\\n'); setTimeout(() => process.stderr.write('x'.repeat(10000)), 30); }, 30);",
		],
		requiredStderrPattern: /using CUDA\d+ backend/,
	});
});

test("GPU-capable build without GPU execution cannot silently succeed", async () => {
	await expect(
		runProcess({
			command: process.execPath,
			args: ["-e", "process.stderr.write('CUDA = 1; using CPU backend');"],
			requiredStderrPattern: /using CUDA\d+ backend/,
		}),
	).rejects.toThrow("did not confirm an active GPU");
});

test("drains subprocess output without blocking completion", async () => {
	await runProcess({
		command: process.execPath,
		args: ["-e", "process.stdout.write('x'.repeat(2_000_000));"],
		timeoutMs: 5000,
	});
});
test("cancellation terminates and rejects a running child", async () => {
	const controller = new AbortController();
	const pending = runProcess({
		command: process.execPath,
		args: ["-e", "setInterval(()=>{},1000)"],
		signal: controller.signal,
	});
	controller.abort();
	await expect(pending).rejects.toThrow("cancelled");
});
test("timeout rejects instead of leaving an orphan child", async () => {
	await expect(
		runProcess({
			command: process.execPath,
			args: ["-e", "setInterval(()=>{},1000)"],
			timeoutMs: 100,
		}),
	).rejects.toThrow("timed out");
});
