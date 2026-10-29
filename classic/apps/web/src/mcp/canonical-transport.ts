import { z } from "zod";

/** These shapes describe the generic Rust protocol, never a feature/tool table. */
export const canonicalDescriptorSchema = z.object({
	id: z.string(),
	title: z.string(),
	description: z.string(),
	version: z.string(),
	inputSchema: z.record(z.string(), z.unknown()),
	outputSchema: z.record(z.string(), z.unknown()),
	access: z.enum(["read", "write", "destructive", "admin"]),
	idempotent: z.boolean(),
	openWorld: z.boolean(),
	transactional: z.boolean(),
	supportsDryRun: z.boolean(),
	cancellable: z.boolean(),
	available: z.boolean(),
	unavailableReason: z.string().nullable(),
	category: z.string(),
	tags: z.array(z.string()),
	documentSupport: z.string(),
	execution: z.string(),
});
export type CanonicalDescriptor = z.infer<typeof canonicalDescriptorSchema>;
export const canonicalRegistrySchema = z.object({
	revision: z.number(),
	capabilities: z.array(canonicalDescriptorSchema),
});
export const invocationOptionsSchema = z
	.object({
		dryRun: z.boolean().default(false),
		requestId: z.string().optional(),
		metadata: z.record(z.string(), z.unknown()).default({}),
	})
	.strict();
export type CanonicalInvocationOptions = z.infer<
	typeof invocationOptionsSchema
>;
export const artifactMetadataSchema = z.object({
	id: z.string(),
	uri: z.string().startsWith("opencut://artifacts/"),
	mimeType: z.string(),
	byteSize: z
		.number()
		.int()
		.nonnegative()
		.max(16 * 1024 * 1024),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	createdAtMs: z.number(),
	expiresAtMs: z.number(),
	width: z.number().nullable(),
	height: z.number().nullable(),
	durationMs: z.number().nullable(),
});
export const canonicalReceiptSchema = z.object({
	capabilityId: z.string(),
	capabilityVersion: z.string(),
	registryRevision: z.number(),
	result: z.object({
		data: z.unknown(),
		summary: z.string().nullable(),
		changedResources: z.array(z.string()),
		artifacts: z.array(artifactMetadataSchema).max(16),
	}),
});
/** Host support is checked both during discovery and immediately before execution. */
export function canonicalMcpDescriptor(
	source: CanonicalDescriptor,
): CanonicalDescriptor {
	const shellOnly = [
		"project.create",
		"project.open",
		"project.activate",
		"project.close",
	].includes(source.id);
	const agentArtifactHost = [
		"editor.preview.render",
		"editor.export.render",
		"hyperframes.examples.import",
		"hyperframes.composition.remix",
		"editor.ui.screenshot",
		"imagegen.generate",
	].includes(source.id);
	if (shellOnly)
		return {
			...source,
			available: false,
			unavailableReason:
				"Use the editor shell to switch or create browser projects",
		};
	if (agentArtifactHost)
		return {
			...source,
			available: false,
			unavailableReason:
				"This adapter requires the internal editing agent artifact host. Use the existing Classic export-plan/start_export_task workflow for live exports.",
		};
	return source;
}
export function advertiseCanonicalRegistry(value: unknown) {
	return canonicalRegistrySchema
		.parse(value)
		.capabilities.map(canonicalMcpDescriptor)
		.map((canonical) => ({
			name: `canonical.${canonical.id}`,
			description: canonical.description,
			parameters: canonical.inputSchema,
			category: canonical.category,
			keywords: canonical.tags,
			readOnly: canonical.access === "read",
			idempotent: canonical.idempotent,
			openWorld: canonical.openWorld,
			risk: canonical.access,
			canonical,
		}));
}
export function encodeArtifactBytes(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 16_384)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
	return btoa(binary);
}
