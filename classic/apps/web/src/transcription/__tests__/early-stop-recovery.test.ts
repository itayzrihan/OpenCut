import { describe, expect, test } from "bun:test";
import { recoverEarlyStoppedTranscription } from "../early-stop-recovery";
import type { TranscriptionResult } from "../types";

function pcmWav({
	durationSeconds,
	audibleUntilSeconds = durationSeconds,
}: {
	durationSeconds: number;
	audibleUntilSeconds?: number;
}) {
	const sampleRate = 1_000;
	const channels = 1;
	const frameCount = durationSeconds * sampleRate;
	const dataLength = frameCount * 2;
	const buffer = new ArrayBuffer(44 + dataLength);
	const view = new DataView(buffer);
	writeAscii({ view, offset: 0, value: "RIFF" });
	view.setUint32(4, 36 + dataLength, true);
	writeAscii({ view, offset: 8, value: "WAVE" });
	writeAscii({ view, offset: 12, value: "fmt " });
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii({ view, offset: 36, value: "data" });
	view.setUint32(40, dataLength, true);
	for (let frame = 0; frame < frameCount; frame += 1) {
		const audible = frame < audibleUntilSeconds * sampleRate;
		view.setInt16(44 + frame * 2, audible ? 4_000 : 0, true);
	}
	return new Blob([buffer], { type: "audio/wav" });
}

function initialResult(): TranscriptionResult {
	return {
		text: "you will lose badly",
		language: "he",
		segments: [{ text: "you will lose badly", start: 1, end: 2 }],
		words: [
			{ text: "you", start: 1, end: 1.3 },
			{ text: "will", start: 1.3, end: 1.5 },
			{ text: "lose", start: 1.5, end: 1.75 },
			{ text: "badly", start: 1.75, end: 2 },
		],
	};
}

describe("early transcription stop recovery", () => {
	test("restarts with overlap and merges words through the audible ending", async () => {
		let recoveryCalls = 0;
		const result = await recoverEarlyStoppedTranscription({
			audioBlob: pcmWav({ durationSeconds: 5 }),
			initialResult: initialResult(),
			transcribe: async () => {
				recoveryCalls += 1;
				return {
					text: "lose badly then continue to the ending",
					language: "he",
					segments: [
						{
							text: "lose badly then continue to the ending",
							start: 0.1,
							end: 3.75,
						},
					],
					words: [
						{ text: "lose", start: 0.1, end: 0.45 },
						{ text: "badly", start: 0.45, end: 0.8 },
						{ text: "then", start: 0.8, end: 1.2 },
						{ text: "continue", start: 1.2, end: 1.6 },
						{ text: "to", start: 1.6, end: 2.3 },
						{ text: "the", start: 2.3, end: 3 },
						{ text: "ending", start: 3, end: 3.75 },
					],
				};
			},
		});

		expect(recoveryCalls).toBe(1);
		expect(result.words?.map((word) => word.text)).toEqual([
			"you",
			"will",
			"lose",
			"badly",
			"then",
			"continue",
			"to",
			"the",
			"ending",
		]);
		expect(result.words?.at(-1)?.end).toBe(4.95);
	});

	test("does not retry when the remaining WAV is silent", async () => {
		let recoveryCalls = 0;
		const result = await recoverEarlyStoppedTranscription({
			audioBlob: pcmWav({
				durationSeconds: 5,
				audibleUntilSeconds: 2,
			}),
			initialResult: initialResult(),
			transcribe: async () => {
				recoveryCalls += 1;
				return initialResult();
			},
		});

		expect(recoveryCalls).toBe(0);
		expect(result).toEqual(initialResult());
	});

	test("keeps recovering while each pass makes progress", async () => {
		let recoveryCalls = 0;
		const result = await recoverEarlyStoppedTranscription({
			audioBlob: pcmWav({ durationSeconds: 5 }),
			initialResult: initialResult(),
			transcribe: async () => {
				recoveryCalls += 1;
				return recoveryCalls === 1
					? {
							text: "lose badly more speech",
							language: "he",
							segments: [
								{ text: "lose badly more speech", start: 0.1, end: 1.8 },
							],
							words: [
								{ text: "lose", start: 0.1, end: 0.45 },
								{ text: "badly", start: 0.45, end: 0.8 },
								{ text: "more", start: 0.8, end: 1.3 },
								{ text: "speech", start: 1.3, end: 1.8 },
							],
						}
					: {
							text: "more speech final words",
							language: "he",
							segments: [
								{ text: "more speech final words", start: 0.1, end: 2.75 },
							],
							words: [
								{ text: "more", start: 0.1, end: 0.45 },
								{ text: "speech", start: 0.45, end: 0.8 },
								{ text: "final", start: 0.8, end: 1.75 },
								{ text: "words", start: 1.75, end: 2.75 },
							],
						};
			},
		});

		expect(recoveryCalls).toBe(2);
		expect(result.words?.slice(-4).map((word) => word.text)).toEqual([
			"more",
			"speech",
			"final",
			"words",
		]);
		expect(result.words?.at(-1)?.end).toBe(4.95);
	});
});

function writeAscii({
	view,
	offset,
	value,
}: {
	view: DataView;
	offset: number;
	value: string;
}) {
	for (let index = 0; index < value.length; index += 1) {
		view.setUint8(offset + index, value.charCodeAt(index));
	}
}
