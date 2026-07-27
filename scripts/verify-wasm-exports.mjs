import { readFile } from "node:fs/promises";

const wasmUrl = new URL(
	"../rust/wasm/pkg/opencut_wasm_bg.wasm",
	import.meta.url,
);
const wasmBytes = await readFile(wasmUrl);
const wasmModule = await WebAssembly.compile(wasmBytes);
const actualExports = new Set(
	WebAssembly.Module.exports(wasmModule).map(({ name }) => name),
);
const requiredExports = [
	"analyzeAudioSilence",
	"authorizeRegisteredAgentCapabilities",
	"buildAiEditPlanRecord",
	"canonicalizeTimelineSourceDocument",
	"detectFastAudioSilence",
	"normalizeTimelineTimeRanges",
	"planAgentRangePreviewFrames",
	"preserveAudioDuringTimeRemoval",
	"realignCaptionWordsAfterTimeRemoval",
	"searchAgentTools",
	"transitionAgentTask",
	"validateTimelineSourceV2MutationScope",
];
const missingExports = requiredExports.filter(
	(name) => !actualExports.has(name),
);

if (missingExports.length > 0) {
	throw new Error(
		`Generated opencut-wasm is missing required exports: ${missingExports.join(", ")}`,
	);
}

console.log(`Verified ${requiredExports.length} required opencut-wasm exports`);
