"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Bridges the renderer to Electron's native, window-parented file dialog. The web/browser
// build instead asks the Next.js server to shell out to a system dialog (see
// services/local-drive/server.ts's chooseFiles), which works fine standalone but has no
// window relationship to the Electron shell — that dialog ends up with no owner window and
// never comes to the front over the app. Routing through the main process here fixes that.
contextBridge.exposeInMainWorld("opencutElectron", {
	setComputerAccess: (scope) => ipcRenderer.invoke("opencut:agent-computer-permissions",scope),
	executeComputerOperation: (request) => ipcRenderer.invoke("opencut:agent-computer-execute",request),
	cancelComputerOperations: () => ipcRenderer.invoke("opencut:agent-computer-cancel"),
	revokeComputerAccess: () => ipcRenderer.invoke("opencut:agent-computer-revoke"),
	pickMediaFiles: () => ipcRenderer.invoke("opencut:pick-media-files"),
	goBack: () => ipcRenderer.invoke("opencut:go-back"),
	canGoBack: () => ipcRenderer.invoke("opencut:can-go-back"),
	captureEditorScreenshot: (scope) => ipcRenderer.invoke("opencut:editor-screenshot", scope),
	controlEditorUi: (scope) => ipcRenderer.invoke("opencut:editor-ui-control", scope),
});
