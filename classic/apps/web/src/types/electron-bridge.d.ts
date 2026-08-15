/** Exposed by apps/electron/app/preload.cjs — undefined outside the Electron shell. */
interface OpenCutElectronBridge {
	pickMediaFiles(): Promise<string[]>;
}

interface Window {
	opencutElectron?: OpenCutElectronBridge;
}
