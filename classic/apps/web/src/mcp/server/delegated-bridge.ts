import { fetchBridge, loadBridgeConfigs } from "./classic-bridge";

export async function findDelegatedBridge({
	accountId,
	projectId,
	signal,
}: {
	accountId: string;
	projectId: string;
	signal: AbortSignal;
}) {
	const path = [
		"delegated",
		encodeURIComponent(accountId),
		encodeURIComponent(projectId),
	];
	const configs = await loadBridgeConfigs();
	for (const config of configs.slice(0, 8)) {
		const inventory = await fetchBridge({
			config,
			path,
			method: "GET",
			contentType: null,
			timeoutMs: 2000,
			signal,
		}).catch(() => null);
		if (inventory?.ok) return { config, path, inventory };
		await inventory?.body?.cancel();
	}
	return null;
}
