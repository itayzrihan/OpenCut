// IndexedDB uses structured clone, whose binary values JSON.stringify discards.
// Read-back verification must compare the bytes as well as the surrounding data.
export async function sameBrowserRecord({
	left,
	right,
	seen = new Map<object, object>(),
}: {
	left: unknown;
	right: unknown;
	seen?: Map<object, object>;
}): Promise<boolean> {
	if (Object.is(left, right)) return true;
	if (!left || !right || typeof left !== "object" || typeof right !== "object")
		return false;
	if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right))
		return false;
	if (seen.has(left)) return seen.get(left) === right;
	seen.set(left, right);
	if (left instanceof Blob && right instanceof Blob) {
		if (left.size !== right.size || left.type !== right.type) return false;
		if (
			left instanceof File &&
			right instanceof File &&
			(left.name !== right.name || left.lastModified !== right.lastModified)
		)
			return false;
		for (let offset = 0; offset < left.size; offset += 8 * 1024 * 1024) {
			const end = offset + 8 * 1024 * 1024;
			const a = new Uint8Array(await left.slice(offset, end).arrayBuffer());
			const b = new Uint8Array(await right.slice(offset, end).arrayBuffer());
			if (a.some((byte, index) => byte !== b[index])) return false;
		}
		return true;
	}
	if (left instanceof Date && right instanceof Date)
		return Object.is(left.getTime(), right.getTime());
	if (left instanceof RegExp && right instanceof RegExp)
		return left.source === right.source && left.flags === right.flags;
	if (left instanceof ArrayBuffer && right instanceof ArrayBuffer)
		return sameBrowserRecord({
			left: new Uint8Array(left),
			right: new Uint8Array(right),
			seen: seen,
		});
	if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
		if (left.byteLength !== right.byteLength) return false;
		const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength),
			b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
		return a.every((byte, index) => byte === b[index]);
	}
	if (left instanceof Map && right instanceof Map)
		return (
			left.size === right.size &&
			sameBrowserRecord({ left: [...left], right: [...right], seen: seen })
		);
	if (left instanceof Set && right instanceof Set)
		return (
			left.size === right.size &&
			sameBrowserRecord({ left: [...left], right: [...right], seen: seen })
		);
	if (
		Array.isArray(left) &&
		Array.isArray(right) &&
		left.length !== right.length
	)
		return false;
	const keys = Object.keys(left),
		other = Object.keys(right);
	if (keys.length !== other.length) return false;
	for (const key of keys) {
		if (
			!Object.hasOwn(right, key) ||
			!(await sameBrowserRecord({
				left: (left as Record<string, unknown>)[key],
				right: (right as Record<string, unknown>)[key],
				seen: seen,
			}))
		)
			return false;
	}
	return true;
}
