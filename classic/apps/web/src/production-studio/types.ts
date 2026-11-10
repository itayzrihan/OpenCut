export interface ScriptContent {
	startMs: number;
	endMs: number;
	sourceLanguage: string;
	sourceText: string;
	latinTransliteration: string;
	speaker: string;
	visualDescription: string;
	timingEstimated: boolean;
}
export interface ScriptVersion extends ScriptContent {
	version: number;
	createdAt: string;
	changeNote: string;
}
export interface ScriptRow {
	id: string;
	currentVersion: number;
	versions: ScriptVersion[];
}
export interface ReferenceVersion {
	version: number;
	referenceId: string;
	caption: string;
	source: "uploaded" | "generated";
	createdAt: string;
}
export interface ReferenceSlot {
	id: string;
	label: string;
	purpose: string;
	slotVersion: number;
	selectedVersion: number | null;
	approvedVersion: number | null;
	versions: ReferenceVersion[];
}
export interface AnalysisObservation {
	aspect: "hook" | "humor" | "cta" | "visuals" | "audio" | "pacing";
	startMs: number;
	endMs: number;
	observation: string;
	interpretation: string;
	confidence: "low" | "medium" | "high";
	evidenceIds: string[];
}
export interface VideoAnalysis {
	id: string;
	mediaId: string;
	sourceDurationMs: number;
	createdAt: string;
	title: string;
	reviewedRanges: Array<{ startMs: number; endMs: number }>;
	observations: AnalysisObservation[];
	limitations: string;
	evidence: Array<{
		id: string;
		uri: string;
		mimeType: string;
		sha256: string;
		byteSize: number;
	}>;
}
export interface ProductionWorkspace {
	scriptRows: ScriptRow[];
	referenceSlots: ReferenceSlot[];
	analyses: VideoAnalysis[];
}
export interface ProductionProjection {
	projectId: string;
	revision: number;
	workspace: ProductionWorkspace;
	instructions: string;
}
export interface ProductionGenerationRequest {
	slotId: string;
	prompt: string;
	referenceIds: string[];
	operationId: string;
	signal: AbortSignal;
	provider: "codex" | "openrouter";
	model?: string;
}
export type GenerateProductionReference = (
	input: ProductionGenerationRequest,
) => Promise<{ blob: Blob; mimeType: string }>;
