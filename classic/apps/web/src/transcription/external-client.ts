import type { TranscriptionLanguage, TranscriptionResult } from "./types";
export interface ExternalSettingsView {
	id?: string;
	configured: boolean;
	endpoint: string;
	model: string;
}
export async function getExternalSettings({
	signal,
}: { signal?: AbortSignal } = {}): Promise<ExternalSettingsView> {
	const response = await fetch("/api/transcription/settings", {
		signal,
		headers: { "X-OpenCut-Account": window.__opencutAccountId ?? "" },
	});
	if (!response.ok)
		throw new Error("Could not read transcription API settings");
	return response.json();
}
/** WAV encoding is a host IO adapter; every request holds at most 90s of PCM. */
export function encodeSpeechWav({ samples }: { samples: Float32Array }): Blob {
	if (!samples.length || samples.length > 90 * 16000)
		throw new Error("Audio window exceeds the bounded transcription limit");
	const bytes = new ArrayBuffer(44 + samples.length * 2);
	const view = new DataView(bytes);
	const ascii = ({ at, value }: { at: number; value: string }) => {
		for (let i = 0; i < value.length; i++)
			view.setUint8(at + i, value.charCodeAt(i));
	};
	ascii({ at: 0, value: "RIFF" });
	view.setUint32(4, 36 + samples.length * 2, true);
	ascii({ at: 8, value: "WAVEfmt " });
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 16000, true);
	view.setUint32(28, 32000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii({ at: 36, value: "data" });
	view.setUint32(40, samples.length * 2, true);
	for (let i = 0; i < samples.length; i++)
		view.setInt16(
			44 + i * 2,
			Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767),
			true,
		);
	return new Blob([bytes], { type: "audio/wav" });
}
export async function transcribeExternalWindow({
	samples,
	language,
	signal,
	configuration,
	account,
}: {
	samples: Float32Array;
	language: TranscriptionLanguage;
	signal: AbortSignal;
	configuration: string;
	account: string;
}): Promise<TranscriptionResult> {
	const audio = encodeSpeechWav({ samples });
	for (let attempt = 0; ; attempt++) {
		signal.throwIfAborted();
		if (window.__opencutAccountId !== account)
			throw new DOMException("Transcription account changed", "AbortError");
		const form = new FormData();
		form.append("audio", audio, "section.wav");
		form.append("language", language);
		form.append("configuration", configuration);
		let response: Response;
		try {
			response = await fetch("/api/transcription/external", {
				method: "POST",
				headers: { "X-OpenCut-Account": account },
				body: form,
				signal,
			});
		} catch (error) {
			if (signal.aborted || attempt >= 2) throw error;
			await delay(signal);
			continue;
		}
		if ((response.status === 429 || response.status === 503) && attempt < 2) {
			await response.body?.cancel();
			await delay(signal);
			continue;
		}
		const result = await response.json();
		if (!response.ok)
			throw new Error(result.error ?? "External transcription failed");
		signal.throwIfAborted();
		if (window.__opencutAccountId !== account)
			throw new DOMException("Transcription account changed", "AbortError");
		return result;
	}
}
function delay(signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		signal.throwIfAborted();
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, 1000);
		signal.addEventListener("abort", abort, { once: true });
	});
}
