import { readFile } from "node:fs/promises";

const requiredExports = [
	"mediaRelinkBinding",
	"mediaMissingUsed",
	"accountConfigureStorage",
	"accountValidateSnapshot",
	"browserRecoveryProject",
	"resolveAudioSyncRetrim",
	"resolveClipAudioTiming",
	"analyzeAudioSilence",
	"authorizeRegisteredAgentCapabilities",
	"buildAiEditPlanRecord",
	"canonicalizeTimelineSourceDocument",
	"compileAutomaticZoom",
	"sampleAutomaticZoom",
	"classicZoomPresets",
	"compileAutomaticTextTransitions",
	"compileAutomaticWordAnimation",
	"compileFullAutoEdit",
	"fullAutoEditStages",
	"automaticMusicCatalog",
	"compileAutomaticMusic",
	"resolveLocalSubjectFraming",
	"batchEditTransition",
	"batchEditIsLocked",
	"detectFastAudioSilence",
	"normalizeTimelineTimeRanges",
	"planAgentRangePreviewFrames",
	"planBackgroundRemovalDuplicate",
	"preserveAudioDuringTimeRemoval",
	"realignCaptionWordsAfterTimeRemoval",
	"removeCaptionWordTimeRanges",
	"resolveBackgroundRemovalSettings",
	"rippleInsertTime",
	"restoreSilence",
	"searchAgentTools",
	"textLayerDurationForWords",
	"transitionAgentTask",
	"validateTimelineSourceV2MutationScope",
];
async function verifyExports(relativePath, required, label) {
	const wasmBytes = await readFile(new URL(relativePath, import.meta.url));
	const wasmModule = await WebAssembly.compile(wasmBytes);
	const actualExports = new Set(
		WebAssembly.Module.exports(wasmModule).map(({ name }) => name),
	);
	const missingExports = required.filter((name) => !actualExports.has(name));

	if (missingExports.length > 0) {
		throw new Error(
			`Generated ${label} is missing required exports: ${missingExports.join(", ")}`,
		);
	}
	console.log(`Verified ${required.length} required ${label} exports`);
}

await verifyExports(
	"../rust/wasm/pkg/opencut_wasm_bg.wasm",
	requiredExports,
	"opencut-wasm",
);
await verifyExports(
	"../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.wasm",
	[
		"canonicaleditorruntime_new",
		"canonicaleditorruntime_invoke",
		"canonicaleditorruntime_invokeSync",
		"canonicaleditorruntime_snapshot",
		"canonicaleditorruntime_capabilities",
		"canonicaleditorruntime_serialize",
		"canonicaleditorruntime_restore",
		"canonicaleditorruntime_readArtifact",
	],
	"opencut-editor-runtime-wasm",
);
