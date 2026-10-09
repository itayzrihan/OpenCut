"use strict";
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { controlOwnedEditor } = require("../app/editor-ui-control.cjs");
const { authorizeEditorScreenshot } = require("../app/editor-screenshot.cjs");
async function run() {
	await app.whenReady();const bundle = readFileSync(process.env.OPENCUT_UI_TEST_BUNDLE);
	const server = createServer((request,response)=>{
		if (request.url === "/ui.mjs") { response.writeHead(200,{"content-type":"text/javascript"});response.end(bundle);return; }
		response.writeHead(200,{"content-type":"text/html; charset=utf-8"});
		response.end(`<!doctype html><main data-opencut-editor-project="project-a"><button id="panel">Effects</button><button id="edit">Delete clip</button><label>Search <input type="search" id="filter"></label><div data-editor-agent-private><button>Private</button></div></main><script type="module">import * as api from '/ui.mjs';window.api=api;window.clicks=0;window.writes=0;window.trusted=0;const panel=document.getElementById('panel'),filter=document.getElementById('filter');panel.addEventListener('click',e=>{window.clicks++;window.trusted+=e.isTrusted?1:0});document.getElementById('edit').addEventListener('click',()=>window.writes++);api.bindEditorUiSurface({element:panel,gestures:['click']});api.bindEditorUiSurface({element:filter,gestures:['fill','key']});window.snapshot=api.captureEditorUi({document,projectId:'project-a',request:{projectId:'project-a',expectedRevision:7}});window.runGesture=(name,gesture,revision=7)=>{const target=window.snapshot.nodes.find(n=>n.name===name);return api.controlEditorUi({request:{projectId:'project-a',expectedRevision:7,snapshotId:window.snapshot.snapshotId,targetId:target.targetId,gesture},accountId:'local',projectId:()=> 'project-a',currentRevision:()=>revision,signal:new AbortController().signal})};</script>`);
	});
	await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const appOrigin=`http://127.0.0.1:${server.address().port}`;
	const options={show:false,width:800,height:600,webPreferences:{preload:join(__dirname,"../app/preload.cjs"),offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}};
	const owned=new BrowserWindow(options),other=new BrowserWindow(options);
	ipcMain.handle("opencut:editor-ui-control",async(event,request)=>{ authorizeEditorScreenshot(event,owned,appOrigin);await controlOwnedEditor(event.sender,{appOrigin,request}); });
	try {
		await Promise.all([owned.loadURL(`${appOrigin}/editor/project-a`),other.loadURL(`${appOrigin}/editor/project-a`)]);
		for (const window of [owned,other]) { for(let tries=0;tries<50;tries++) { if(await window.webContents.executeJavaScript("!!window.runGesture")) break;await new Promise(resolve=>setTimeout(resolve,20)); } }
		const receipt=await owned.webContents.executeJavaScript("window.runGesture('Effects',{type:'click'})");assert.equal(receipt.transport,"ownedPlaywright");
		await owned.webContents.executeJavaScript("window.runGesture('Search',{type:'fill',text:'כותרת glass'})");
		assert.deepEqual(await owned.webContents.executeJavaScript("({clicks:window.clicks,writes:window.writes,trusted:window.trusted,text:document.getElementById('filter').value})"),{clicks:1,writes:0,trusted:1,text:"כותרת glass"});
		await assert.rejects(owned.webContents.executeJavaScript("window.runGesture('Delete clip',{type:'click'})"));
		await assert.rejects(owned.webContents.executeJavaScript("window.runGesture('Effects',{type:'click'},8)"));
		await assert.rejects(other.webContents.executeJavaScript("window.runGesture('Effects',{type:'click'})"));
		assert.equal(await other.webContents.executeJavaScript("window.clicks"),0);assert.equal(owned.webContents.debugger.isAttached(),false);
		assert.equal(await owned.webContents.executeJavaScript("!!window.__opencutEditorUiControl"),false);
		console.log(JSON.stringify({type:"editor-ui-control-pass",checks:9}));
	} finally { owned.destroy();other.destroy();server.close(); }
}
run().then(()=>app.exit(0),error=>{ console.error(error);app.exit(1); });
