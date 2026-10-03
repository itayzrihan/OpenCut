// A portable structured-clone graph. Explicit tags preserve dates, binary
// values, undefined, maps, sets, shared references and cycles without eval.
export async function encodeBrowserGraph(
	value: unknown,
	storeBlob: (blob: Blob) => Promise<string>,
) {
	const nodes: Record<string, unknown>[] = [],
		seen = new Map<object, number>();
	async function encode(item: unknown): Promise<unknown> {
		if (item === undefined) return { type: "undefined" };
		if (typeof item === "bigint")
			return { type: "bigint", value: item.toString() };
		if (
			typeof item === "number" &&
			(!Number.isFinite(item) || Object.is(item, -0))
		)
			return {
				type: "number",
				value: Object.is(item, -0) ? "-0" : String(item),
			};
		if (
			item === null ||
			typeof item === "string" ||
			typeof item === "boolean" ||
			typeof item === "number"
		)
			return { type: "primitive", value: item };
		if (typeof item !== "object")
			throw new Error("Unsupported browser record value");
		if (seen.has(item)) return { ref: seen.get(item) };
		const id = nodes.length,
			node: Record<string, unknown> = {};
		nodes.push(node);
		seen.set(item, id);
		if (item instanceof Blob) {
			Object.assign(node, {
				type: item instanceof File ? "file" : "blob",
				object: await storeBlob(item),
				mimeType: item.type,
				size: item.size,
			});
			if (item instanceof File)
				Object.assign(node, {
					name: item.name,
					lastModified: item.lastModified,
				});
		} else if (item instanceof Date)
			Object.assign(node, {
				type: "date",
				value: Number.isNaN(item.getTime()) ? null : item.toISOString(),
			});
		else if (item instanceof RegExp)
			Object.assign(node, {
				type: "regexp",
				source: item.source,
				flags: item.flags,
			});
		else if (item instanceof ArrayBuffer)
			Object.assign(node, {
				type: "arrayBuffer",
				object: await storeBlob(new Blob([item])),
				size: item.byteLength,
			});
		else if (ArrayBuffer.isView(item))
			Object.assign(node, {
				type: "view",
				constructor: item.constructor.name,
				buffer: await encode(item.buffer),
				byteOffset: item.byteOffset,
				byteLength: item.byteLength,
			});
		else if (item instanceof Map) {
			const entries = [];
			for (const [key, entry] of item)
				entries.push([await encode(key), await encode(entry)]);
			Object.assign(node, { type: "map", entries });
		} else if (item instanceof Set) {
			const entries = [];
			for (const entry of item) entries.push(await encode(entry));
			Object.assign(node, { type: "set", entries });
		} else {
			if (
				!Array.isArray(item) &&
				Object.getPrototypeOf(item) !== Object.prototype &&
				Object.getPrototypeOf(item) !== null
			)
				throw new Error(
					`Unsupported browser record: ${item.constructor?.name}`,
				);
			const entries = [];
			for (const key of Object.keys(item))
				entries.push([
					key,
					await encode((item as Record<string, unknown>)[key]),
				]);
			Object.assign(node, {
				type: Array.isArray(item) ? "array" : "object",
				entries,
				...(Array.isArray(item) ? { length: item.length } : {}),
			});
		}
		return { ref: id };
	}
	return {
		format: "opencut-browser-graph-v1",
		root: await encode(value),
		nodes,
	};
}

export async function decodeBrowserGraph(
	graph: Awaited<ReturnType<typeof encodeBrowserGraph>>,
	readBlob: (id: string) => Promise<Blob>,
): Promise<unknown> {
	if (
		graph.format !== "opencut-browser-graph-v1" ||
		graph.nodes.length > 1_000_000
	)
		throw new Error("Invalid browser graph");
	const built = new Map<number, unknown>();
	const views: Record<
		string,
		{
			new (
				buffer: ArrayBuffer,
				byteOffset: number,
				length: number,
			): ArrayBufferView;
			BYTES_PER_ELEMENT: number;
		}
	> = {
		Int8Array,
		Uint8Array,
		Uint8ClampedArray,
		Int16Array,
		Uint16Array,
		Int32Array,
		Uint32Array,
		Float32Array,
		Float64Array,
		BigInt64Array,
		BigUint64Array,
	};
	async function decode(value: unknown): Promise<unknown> {
		if (!value || typeof value !== "object")
			throw new Error("Invalid graph value");
		const tag = value as { ref?: number; type?: string; value?: unknown };
		if (tag.ref !== undefined) return build(tag.ref);
		switch (tag.type) {
			case "undefined":
				return undefined;
			case "primitive":
				return tag.value;
			case "bigint":
				return BigInt(String(tag.value));
			case "number":
				return Number(tag.value);
			default:
				throw new Error("Invalid graph value tag");
		}
	}
	async function build(id: number): Promise<unknown> {
		if (built.has(id)) return built.get(id);
		if (!Number.isInteger(id) || id < 0 || id >= graph.nodes.length)
			throw new Error("Invalid browser graph reference");
		const node = graph.nodes[id];
		let value: unknown;
		switch (node.type) {
			case "object":
				value = {};
				break;
			case "array":
				if (
					!Number.isSafeInteger(node.length) ||
					Number(node.length) < 0 ||
					Number(node.length) > 1_000_000
				)
					throw new Error("Invalid array length");
				value = new Array(Number(node.length));
				break;
			case "map":
				value = new Map();
				break;
			case "set":
				value = new Set();
				break;
			case "date":
				value = new Date(node.value === null ? NaN : String(node.value));
				break;
			case "regexp":
				value = new RegExp(String(node.source), String(node.flags));
				break;
			case "blob":
			case "file":
			case "arrayBuffer": {
				const blob = await readBlob(String(node.object));
				if (blob.size !== node.size)
					throw new Error("Archive binary size mismatch");
				value =
					node.type === "arrayBuffer"
						? await blob.arrayBuffer()
						: node.type === "file"
							? new File([blob], String(node.name), {
									type: String(node.mimeType),
									lastModified: Number(node.lastModified),
								})
							: new Blob([blob], { type: String(node.mimeType) });
				break;
			}
			case "view": {
				const buffer = await decode(node.buffer);
				if (!(buffer instanceof ArrayBuffer))
					throw new Error("Invalid view buffer");
				const name = String(node.constructor),
					offset = Number(node.byteOffset),
					bytes = Number(node.byteLength);
				if (name === "DataView") value = new DataView(buffer, offset, bytes);
				else {
					const type = views[name];
					if (!type) throw new Error("Unknown binary view");
					value = new type(buffer, offset, bytes / type.BYTES_PER_ELEMENT);
				}
				break;
			}
			default:
				throw new Error("Unknown browser archive node");
		}
		built.set(id, value);
		if (node.type === "map")
			for (const [key, item] of node.entries as [unknown, unknown][])
				(value as Map<unknown, unknown>).set(
					await decode(key),
					await decode(item),
				);
		else if (node.type === "set")
			for (const item of node.entries as unknown[])
				(value as Set<unknown>).add(await decode(item));
		else if (node.type === "array" || node.type === "object")
			for (const [key, item] of node.entries as [string, unknown][])
				Object.defineProperty(value, key, {
					value: await decode(item),
					enumerable: true,
					configurable: true,
					writable: true,
				});
		return value;
	}
	return decode(graph.root);
}
