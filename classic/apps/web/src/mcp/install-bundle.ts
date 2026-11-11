import { createZipBlob } from "@/project/archive/zip";

const assets = ["README.md", "install.mjs", "pocut-mcp.mjs", "client-cli.mjs"];

function base64url(bytes: Uint8Array) {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export async function encryptMcpInstallation(payload: {
	activation: string;
	origin: string;
}) {
	const keyBytes = crypto.getRandomValues(new Uint8Array(32));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
		"encrypt",
	]);
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(JSON.stringify(payload)),
	);
	const code = base64url(keyBytes);
	keyBytes.fill(0);
	return {
		code,
		envelope: {
			version: 1,
			iv: base64url(iv),
			encrypted: base64url(new Uint8Array(encrypted)),
		},
	};
}

export async function createMcpInstallationZip({
	payload,
	signal,
}: {
	payload: { activation: string; origin: string };
	signal: AbortSignal;
}) {
	const { code, envelope } = await encryptMcpInstallation(payload);
	const entries = await Promise.all(
		assets.map(async (path) => {
			const response = await fetch(`/mcp-install/${path}`, { signal });
			if (!response.ok)
				throw new Error("The MCP installer files are unavailable.");
			return { path, data: await response.blob() };
		}),
	);
	return {
		code,
		zip: await createZipBlob({
			entries: [
				...entries,
				{
					path: "POCUT-MCP-ENCRYPTED-DO-NOT-READ.json",
					data: new Blob([JSON.stringify(envelope)], {
						type: "application/json",
					}),
				},
			],
		}),
	};
}
