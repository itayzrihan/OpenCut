"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const account = process.argv
	.find((a) => a.startsWith("--opencut-render-account="))
	?.split("=")[1];
if (account) window.localStorage.setItem("opencut-active-account-v1", account);
contextBridge.exposeInMainWorld("opencutRenderWorker", {
	idle: () => ipcRenderer.send("opencut-render-worker-idle"),
});
