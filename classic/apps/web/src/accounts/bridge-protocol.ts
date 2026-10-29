import { z } from "zod";

/** Older version-2 peers know only legacy tools and transport revisions. */
export function legacyBridgeBody({
	body,
	operation,
}: {
	body: ArrayBuffer;
	operation: "state" | "heartbeat";
}): ArrayBuffer {
	const value = z
		.record(z.string(), z.unknown())
		.parse(JSON.parse(new TextDecoder().decode(body)));
	delete value.canonicalRevision;
	if (operation === "state" && Array.isArray(value.tools)) {
		value.tools = value.tools.filter((tool: unknown) => {
			if (!tool || typeof tool !== "object") return false;
			if ("canonical" in tool) return false;
			return !(
				"name" in tool &&
				typeof tool.name === "string" &&
				tool.name.startsWith("canonical.")
			);
		});
	}
	return new TextEncoder().encode(JSON.stringify(value)).buffer;
}
