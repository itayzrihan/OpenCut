/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The Rust runtime validates the plan and constructs bounded artifact metadata. */
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
	processCompositionAudio,
	probeMediaProfile,
} from "@hyperframes/engine";
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import type { HyperframesAudioPlan } from "./audio-plan";
import type { HyperframesPreviewResource } from "./preview-host";
import type { HyperframesSource } from "./types";

export interface HyperframesAudioArtifact {
	id: string;
	uri: string;
	mimeType: string;
	byteSize: number;
	sha256: string;
	createdAtMs: number;
	expiresAtMs: number;
	width: null;
	height: null;
	durationMs: number;
}

/** Host I/O only: source/plan validation belongs to Rust and audio timing,
 * automation, effects and bus mixing belong to the pinned HyperFrames engine. */
export async function renderHyperframesAudio({
	source,
	plan,
	resources,
	runtime,
	signal,
}: {
	source: HyperframesSource;
	plan: HyperframesAudioPlan;
	resources: ReadonlyMap<string, HyperframesPreviewResource>;
	runtime: CanonicalEditorRuntime;
	signal?: AbortSignal;
}): Promise<HyperframesAudioArtifact | null> {
	signal?.throwIfAborted();
	const prepared = (
		runtime.invokeSync(
			"hyperframes.audio.prepare",
			{ source, plan },
			undefined,
		) as {
			result: { data: HyperframesAudioPlan };
		}
	).result.data;
	if (!prepared.elements.length) return null;
	const cancellation = AbortSignal.any([
		...(signal ? [signal] : []),
		AbortSignal.timeout(5 * 60_000),
	]);
	const root = resolve(tmpdir());
	const folder = await mkdtemp(join(root, "opencut-hf-audio-"));
	if (!resolve(folder).startsWith(`${root}${sep}opencut-hf-audio-`))
		throw new Error(
			"HyperFrames audio scratch directory is outside the temporary root",
		);
	try {
		const staged = new Map<string, string>();
		let bytes = 0;
		for (const element of prepared.elements) {
			cancellation.throwIfAborted();
			if (staged.has(element.src)) continue;
			const resource = resources.get(element.src);
			if (!resource)
				throw new Error(
					`Link the missing HyperFrames audio resource: ${element.src}`,
				);
			const size = (await stat(resource.path)).size;
			bytes += size;
			if (bytes > 512 * 1024 * 1024)
				throw new Error("HyperFrames audio resources exceed 512 MiB");
			// Never turn an authored path or ID into a scratch filesystem path.
			const name = `resource-${staged.size}`;
			await copyFile(resource.path, join(folder, name));
			staged.set(element.src, name);
		}
		cancellation.throwIfAborted();
		const audible = [];
		const profiles = new Map<string, boolean>();
		for (const element of prepared.elements) {
			if (element.type === "video") {
				let hasAudio = profiles.get(element.src);
				if (hasAudio === undefined) {
					hasAudio = (
						await probeMediaProfile(join(folder, staged.get(element.src)!), {
							signal: cancellation,
						})
					).hasAudioStream;
					profiles.set(element.src, hasAudio);
				}
				if (!hasAudio) continue;
			}
			if (element.looping)
				throw new Error(
					"Looped HyperFrames audio is not supported by the pinned mixer yet",
				);
			audible.push({ ...element, src: staged.get(element.src)! });
		}
		if (!audible.length) return null;
		const output = join(folder, "audio.m4a");
		const result = await processCompositionAudio(
			audible,
			folder,
			join(folder, "mix"),
			output,
			prepared.durationSeconds,
			cancellation,
			{ ffmpegProcessTimeout: 60_000 },
		);
		cancellation.throwIfAborted();
		// The engine may report successful output with dropped automation. Treat
		// that degradation as a failure so an export never silently loses it.
		if (!result.success || result.error || result.failures?.length)
			throw new Error(result.error || "HyperFrames audio could not be mixed");
		if ((await stat(output)).size > 64 * 1024 * 1024)
			throw new Error("HyperFrames mixed audio exceeds 64 MiB");
		const outputBytes = await readFile(output);
		cancellation.throwIfAborted();
		return runtime.storeArtifact(
			outputBytes,
			"audio/mp4",
			undefined,
			undefined,
			BigInt(Math.round(prepared.durationSeconds * 1000)),
		) as HyperframesAudioArtifact;
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}
