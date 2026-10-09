/** Host protocol for crates/editor-agent. Editor feature schemas come directly
 * from the live registry; this file must never become a feature/tool table. */
export interface EditingAgentScope {
	accountId: string;
	projectId: string;
	runId: string;
}

export interface EditingConversationEntry {
	attachments?: EditingInputAttachment[];
	id: string;
	kind: "user" | "round" | "status";
	text: string;
	summary?: string;
	review: boolean;
	interrupted: boolean;
	activities?: EditingAgentProviderRound["activities"];
	issues?: string[];
	artifactIds?: string[];
	export?: { artifactId: string; filename: string };
}
export interface EditingConversationArchive {
	schemaVersion: number;
	accountId: string;
	projectId: string;
	entries: EditingConversationEntry[];
	nextId: number;
	activeRound: string | null;
}
export interface EditingArtifactArchive {
	unavailableIds?: string[];
	accountId: string;
	projectId: string;
	archive: {
		schemaVersion: number;
		items: Array<{
			metadata: {
				id: string;
				mimeType: string;
				byteSize: number;
				sha256: string;
			};
			dataBase64: string;
		}>;
	};
}
export type EditingConversationEvent =
	| { type: "user"; text: string; attachments?: EditingInputAttachment[] }
	| { type: "text" | "summary" | "status"; text: string }
	| { type: "round"; review: boolean }
	| { type: "activities"; activities: EditingAgentProviderRound["activities"] }
	| { type: "artifacts"; artifactIds: string[] }
	| { type: "review"; summary: string; issues: string[]; artifactIds: string[] }
	| { type: "export"; artifactId: string; filename: string }
	| { type: "pause" | "close" };
export interface EditingInputAttachment {
	artifactId: string;
	filename: string;
}

export interface EditingAgentProviderRequest {
	epoch: number;
	revision: number;
	body: Record<string, unknown>;
}

export interface EditingAgentReviewPlan {
	epoch: number;
	revision: number;
	sceneId: string;
	times: number[];
	sampled: boolean;
}
export interface EditingAgentReviewResult {
	issues: string[];
	summary: string;
}
export interface EditingAgentReviewRequest {
	model: string;
	epoch: number;
	revision: number;
	frames: Array<{ artifactId: string; timeTicks: number }>;
}

export interface EditingAgentProviderRound {
	pendingHost: EditingAgentHostEffect | null;
	activities: Array<{
		callId: string;
		title: string;
		input: unknown;
		output: unknown;
		ok: boolean;
		status?: "running" | "completed" | "failed";
		groupId?: string;
		startedAt?: number;
		completedAt?: number;
		durationMs?: number;
	}>;
	phase: EditingAgentSnapshot["phase"];
	needsVerification: boolean;
	message: string | null;
}

export interface EditingAgentHostEffect {
	id: number;
	adapter: string;
	projectId: string;
	request: unknown;
}
export type EditingAgentHostResult =
	| { type: "success"; data: unknown }
	| { type: "rejected"; message: string };

export interface EditingAgentPlanStep {
	title: string;
	status: "pending" | "inProgress" | "complete";
}

export type EditingAgentCommand =
	| { type: "observe" }
	| { type: "discover"; query: string; limit: number }
	| { type: "describe"; epoch: number; id: string }
	| { type: "plan"; epoch: number; steps: EditingAgentPlanStep[] }
	| {
			type: "invoke";
			epoch: number;
			callId: string;
			id: string;
			input: unknown;
	  }
	| { type: "steer"; text: string }
	| { type: "pause" }
	| { type: "resume"; scope: EditingAgentScope }
	| { type: "finish"; epoch: number; text: string }
	| { type: "fail"; epoch: number; text: string };

export interface EditingAgentSnapshot {
	scope: EditingAgentScope;
	request: string;
	steering: string[];
	plan: EditingAgentPlanStep[];
	epoch: number;
	revision: number | null;
	phase:
		| "needsObservation"
		| "ready"
		| "awaitingTool"
		| "needsVerification"
		| "paused"
		| "completed"
		| "failed";
	receipts: Array<{
		callId: string;
		capabilityId: string;
		revision: number | null;
		committed: boolean;
		artifactIds: string[];
	}>;
	finalMessage: string | null;
}
