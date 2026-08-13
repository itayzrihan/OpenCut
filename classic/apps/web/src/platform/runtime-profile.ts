export type OpenCutRuntimeTarget = "browser" | "electron";

export const ELECTRON_USER_AGENT_TOKEN = "OpenCutElectron/";

const BUILT_RUNTIME_TARGET: OpenCutRuntimeTarget =
	process.env.NEXT_PUBLIC_OPENCUT_RUNTIME_TARGET === "electron"
		? "electron"
		: "browser";

export function detectRuntimeTarget({
	userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
	builtTarget = BUILT_RUNTIME_TARGET,
}: {
	userAgent?: string;
	builtTarget?: OpenCutRuntimeTarget;
} = {}): OpenCutRuntimeTarget {
	return builtTarget === "electron" || userAgent.includes(ELECTRON_USER_AGENT_TOKEN)
		? "electron"
		: "browser";
}

export function getWasmThreadCount({
	crossOriginIsolated,
	hardwareConcurrency,
	target = detectRuntimeTarget(),
}: {
	crossOriginIsolated: boolean;
	hardwareConcurrency: number;
	target?: OpenCutRuntimeTarget;
}): number {
	if (!crossOriginIsolated) return 1;

	const availableCores = Math.max(1, Math.floor(hardwareConcurrency || 1) - 1);
	const targetLimit = target === "electron" ? 8 : 4;
	return Math.min(targetLimit, availableCores);
}
