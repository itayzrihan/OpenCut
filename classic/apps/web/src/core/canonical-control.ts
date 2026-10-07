import { z } from "zod";

export interface CanonicalControlAction {
	capabilityId: string;
	input: Record<string, unknown>;
}
export interface CanonicalControlBinding {
	accountId: string;
	projectId: string;
	action: CanonicalControlAction;
}

const schema = z
	.object({
		accountId: z.string().min(1).max(256),
		projectId: z.string().min(1).max(256),
		action: z
			.object({
				capabilityId: z.string().min(1).max(160),
				input: z.record(z.string(), z.json()),
			})
			.strict(),
	})
	.strict();
// DOM nodes are host-owned identities. Authored HTML attributes cannot create
// a binding, and unmounted controls do not retain editor/project references.
const bindings = new WeakMap<Element, CanonicalControlBinding>();

export function bindCanonicalControl({
	element,
	binding,
}: {
	element: Element;
	binding: CanonicalControlBinding;
}): () => void {
	const parsed = schema.parse(binding);
	if (new TextEncoder().encode(JSON.stringify(parsed)).length > 12_000)
		throw new Error("A control action exceeds its context budget");
	if (
		"projectId" in parsed.action.input ||
		"expectedRevision" in parsed.action.input
	)
		throw new Error("Control scope is supplied by the editor host");
	bindings.set(element, parsed);
	return () => {
		if (bindings.get(element) === parsed) bindings.delete(element);
	};
}

export function readCanonicalControl({
	element,
	accountId,
	projectId,
	revision,
}: {
	element: Element;
	accountId: string;
	projectId: string;
	revision: number;
}): CanonicalControlAction | null {
	const action = getCanonicalControlAction({ element, accountId, projectId });
	return action
		? {
				...action,
				input: { ...action.input, projectId, expectedRevision: revision },
			}
		: null;
}

/** Clicks and observations consume the same captured, validated declaration. */
export function getCanonicalControlAction({
	element,
	accountId,
	projectId,
}: {
	element: Element;
	accountId: string;
	projectId: string;
}): CanonicalControlAction | null {
	const binding = bindings.get(element);
	if (
		!binding ||
		binding.accountId !== accountId ||
		binding.projectId !== projectId
	)
		return null;
	return structuredClone(binding.action);
}
