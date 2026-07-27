export function isEditorSnapshotEqual({
	a,
	b,
}: {
	a: unknown;
	b: unknown;
}): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return false;
		if (a.length !== b.length) return false;
		return a.every((item, i) => Object.is(item, b[i]));
	}
	if (!isSnapshotObject(a) || !isSnapshotObject(b)) {
		return false;
	}
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every((key) => Object.is(a[key], b[key]));
}

function isSnapshotObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
