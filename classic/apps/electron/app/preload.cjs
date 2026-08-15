"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Bridges the renderer to Electron's native, window-parented file dialog. The web/browser
// build instead asks the Next.js server to shell out to a system dialog (see
// services/local-drive/server.ts's chooseFiles), which works fine standalone but has no
// window relationship to the Electron shell — that dialog ends up with no owner window and
// never comes to the front over the app. Routing through the main process here fixes that.
contextBridge.exposeInMainWorld("opencutElectron", {
	pickMediaFiles: () => ipcRenderer.invoke("opencut:pick-media-files"),
});
