/** Exposed by apps/electron/app/preload.cjs — undefined outside the Electron shell. */
interface OpenCutElectronBridge {
	setComputerAccess(scope: {
		accountId: string;
		projectId: string;
		generation: number;
		mode: import("@/core/agent-protocol").EditingAgentPolicy["mode"];
		enabled: boolean;
	}): Promise<{ enabled: boolean }>;
	executeComputerOperation(
		request: Record<string, unknown>,
	): Promise<
		| { type: "success"; data: { text: string } }
		| { type: "rejected" | "uncertain"; message: string }
	>;
	cancelComputerOperations(): Promise<void>;
	revokeComputerAccess(): Promise<void>;

	canGoBack?(): Promise<boolean>;
	goBack?(): Promise<void>;
	pickMediaFiles(): Promise<string[]>;
	controlEditorUi(scope: {
		accountId: string;
		projectId: string;
		bridgeId: string;
	}): Promise<void>;
	captureEditorScreenshot(scope: {
		accountId: string;
		projectId: string;
	}): Promise<{
		bytes: Uint8Array;
		width: number;
		height: number;
	}>;
}

interface Window {
	opencutElectron?: OpenCutElectronBridge;
}
