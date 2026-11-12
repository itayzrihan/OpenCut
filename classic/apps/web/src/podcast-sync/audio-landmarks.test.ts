import { expect, test } from "bun:test";
import {
	AudioLandmarks,
	buildLandmarkIndex,
	rankLandmarkOffsets,
} from "./audio-landmarks";
import { consensusOffset } from "./guided-sync";

test("a degraded audio excerpt votes for its position among independent content", () => {
	const master = new AudioLandmarks();
	const query = new AudioLandmarks();
	const sampleRate = 16000;
	const start = 9.6;
	const duration = 10;
	let state = 991;
	let pitch = 300;
	let secondary = 800;
	for (let i = 0; i < sampleRate * 27; i++) {
		if (i % 1920 === 0) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			pitch = 150 + (state % 980);
			secondary = 1100 + ((state >>> 16) % 700);
		}
		const sample =
			Math.sin((2 * Math.PI * i * pitch) / sampleRate) +
			0.35 * Math.sin((2 * Math.PI * i * secondary) / sampleRate);
		master.push(sample);
		if (i >= start * sampleRate && i < (start + duration) * sampleRate)
			query.push(sample * 0.4 + Math.sin(i * 0.13) * 0.015);
	}
	const ranked = rankLandmarkOffsets({
		index: buildLandmarkIndex(master.finish()),
		probes: [{ at: 2, landmarks: query.finish() }],
	});
	expect(ranked.some((offset) => Math.abs(offset - (start - 2)) < 0.15)).toBe(
		true,
	);
});

test("weak probes cannot override independent evidence, and tied candidates stay unresolved", () => {
	const first = { at: 0, offset: 14, confidence: 0.83 };
	const second = { at: 30, offset: 14.02, confidence: 0.75 };
	expect(
		consensusOffset([{ at: 10, offset: 270, confidence: 0.3 }, first, second]),
	).toBeCloseTo(14.02, 5);
	expect(
		consensusOffset([
			first,
			second,
			{ ...first, offset: 55 },
			{ ...second, offset: 55.02 },
		]),
	).toBeNull();
});
