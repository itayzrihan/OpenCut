import type { MediaTime } from "@/wasm";
import {
	serializeTimelineDocumentV2ForCore,
	type ParsedTimelineDocumentV2,
} from "./timeline-document-v2";
import { defaultTimelineDocumentV2MutationScopeValidator } from "./timeline-document-v2-scope-validator";

export interface TimelineDocumentV2MutationRange {
	startTime: MediaTime;
	duration: MediaTime;
}

export interface TimelineDocumentV2MutationScopeDiagnostic {
	code: string;
	path: string;
	message: string;
}

export interface TimelineDocumentV2MutationScopeResult {
	valid: boolean;
	diagnostics: TimelineDocumentV2MutationScopeDiagnostic[];
}

export type TimelineDocumentV2MutationScopeValidator = (options: {
	beforeJson: string;
	afterJson: string;
	selectedRange?: TimelineDocumentV2MutationRange;
}) => TimelineDocumentV2MutationScopeResult;

/**
 * Thin web adapter for the Rust-owned Timeline Source v2 mutation boundary.
 * The UI shell only serializes its in-memory scene shape and fails closed if
 * the generated WASM package is stale or returns an invalid result.
 */
export function validateTimelineDocumentV2MutationScope({
	before,
	after,
	selectedRange,
	validate,
}: {
	before: ParsedTimelineDocumentV2;
	after: ParsedTimelineDocumentV2;
	selectedRange?: TimelineDocumentV2MutationRange | null;
	validate?: TimelineDocumentV2MutationScopeValidator;
}): TimelineDocumentV2MutationScopeResult {
	const validator = validate ?? defaultTimelineDocumentV2MutationScopeValidator;
	if (typeof validator !== "function") {
		return unavailableResult(
			"validateTimelineSourceV2MutationScope is unavailable; rebuild the opencut-wasm package",
		);
	}

	try {
		const result = validator({
			beforeJson: serializeTimelineDocumentV2ForCore({ document: before }),
			afterJson: serializeTimelineDocumentV2ForCore({ document: after }),
			...(selectedRange ? { selectedRange } : {}),
		});
		if (!isMutationScopeResult(result)) {
			return unavailableResult(
				"validateTimelineSourceV2MutationScope returned an invalid result",
			);
		}
		return {
			valid: result.valid,
			diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic })),
		};
	} catch (error) {
		return unavailableResult(
			error instanceof Error
				? `Timeline mutation validation failed: ${error.message}`
				: "Timeline mutation validation failed",
		);
	}
}

function isMutationScopeResult(
	value: unknown,
): value is TimelineDocumentV2MutationScopeResult {
	if (!isRecord(value) || typeof value.valid !== "boolean") return false;
	if (!Array.isArray(value.diagnostics)) return false;
	return value.diagnostics.every(
		(diagnostic) =>
			isRecord(diagnostic) &&
			typeof diagnostic.code === "string" &&
			typeof diagnostic.path === "string" &&
			typeof diagnostic.message === "string",
	);
}

function unavailableResult(
	message: string,
): TimelineDocumentV2MutationScopeResult {
	return {
		valid: false,
		diagnostics: [
			{
				code: "wasm_scope_validation_unavailable",
				path: "$",
				message,
			},
		],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
