export function resolveClientCli(client: "codex" | "claude", executable?: string): Promise<{ file: string; prefix: string[] }>;
export function registerMcpClient(options: {
	client: "codex" | "claude";
	name: string;
	command: string;
	relay: string;
	executable?: string;
	run?: (file: string, args: string[], options: { windowsHide: boolean; timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
}): Promise<void>;
