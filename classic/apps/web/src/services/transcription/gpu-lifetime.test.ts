import { expect, test } from "bun:test";
import { boundWhisperGpuOutputs } from "./gpu-lifetime";

test("releases remaining GPU outputs after each window, preserving CPU results and session weights", async () => {
	const allocations: Array<{ location: string; dispose(): void }> = [];
	const tensor = (location = "gpu-buffer") => {
		const value = {
			location,
			dispose() {
				expect(this.location).not.toBe("none");
				this.location = "none";
			},
		};
		allocations.push(value);
		return value;
	};
	const weights = tensor();
	const cpu = tensor("cpu");
	const sessions = {
		encoder: { run: async () => ({ hidden: tensor() }) },
		decoder: { run: async () => ({ kv: tensor(), tokens: cpu }) },
	};
	const model = {
		sessions,
		generate: async () => {
			const hidden = (await sessions.encoder.run()).hidden;
			const first = (await sessions.decoder.run()).kv;
			first.dispose(); // The library disposes some outputs itself.
			const second = (await sessions.decoder.run()).kv;
			expect(hidden.location).toBe("gpu-buffer");
			expect(second.location).toBe("gpu-buffer");
			return cpu;
		},
	};
	boundWhisperGpuOutputs(model);
	for (let i = 0; i < 3; i++) {
		expect(await model.generate()).toBe(cpu);
		expect(allocations.filter((v) => v.location === "gpu-buffer")).toEqual([
			weights,
		]);
		expect(cpu.location).toBe("cpu");
	}
});
test("inference failure also frees outstanding GPU outputs", async () => {
	const output = {
		location: "gpu-buffer",
		dispose() {
			this.location = "none";
		},
	};
	const sessions = { encoder: { run: async () => ({ output }) } };
	const model = {
		sessions,
		generate: async () => {
			await sessions.encoder.run();
			throw new Error("Inference failed");
		},
	};
	boundWhisperGpuOutputs(model);
	await expect(model.generate()).rejects.toThrow("Inference failed");
	expect(output.location).toBe("none");
});
