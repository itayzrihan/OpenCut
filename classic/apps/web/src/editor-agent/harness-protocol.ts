import { z } from "zod";

// This protocol carries scheduling, never editor authority or credentials.
export const harnessId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const harnessPhase = z.enum([
	"needsObservation",
	"ready",
	"awaitingTool",
	"needsVerification",
	"paused",
	"completed",
	"failed",
]);
export const harnessEvent = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("ready"),
			runId: harnessId,
			token: z.string().length(64),
		})
		.strict(),
	z
		.object({
			type: z.literal("call"),
			callId: harnessId,
			operation: z.enum(["provider", "apply"]),
			round: z.number().int().positive(),
		})
		.strict(),
	z.object({ type: z.literal("done"), phase: harnessPhase }).strict(),
	z
		.object({ type: z.literal("error"), message: z.string().max(2000) })
		.strict(),
]);
export type HarnessEvent = z.infer<typeof harnessEvent>;
export type HarnessCall = Extract<HarnessEvent, { type: "call" }>;
export const harnessReply = z
	.object({
		type: z.literal("reply"),
		runId: harnessId,
		projectId: harnessId,
		token: z.string().regex(/^[a-f0-9]{64}$/),
		callId: harnessId,
		result: z.unknown().optional(),
		error: z.string().min(1).max(2000).optional(),
	})
	.strict();
export const harnessStart = z
	.object({
		type: z.literal("start"),
		projectId: harnessId,
		model: z.string().min(1).max(100),
	})
	.strict();
export const canonicalProviderResult = z
	.object({
		epoch: z.number().int().nonnegative(),
		response: z.record(z.string(), z.unknown()),
	})
	.strict();
export const canonicalApplyResult = z.object({ phase: harnessPhase }).strict();
export type HarnessPhase = z.infer<typeof harnessPhase>;
