/** Exposed by apps/electron/app/preload.cjs — undefined outside the Electron shell. */
interface OpenCutElectronBridge {
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
