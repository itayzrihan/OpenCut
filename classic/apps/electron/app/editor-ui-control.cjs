"use strict";
const { connectOwnedWindow } = require("./owned-playwright.cjs");
// No caller-supplied script, selector, URL, path or CDP command. The renderer
// resolves opaque snapshot identities against host-owned presentation bindings.
async function controlOwnedEditor(webContents, { appOrigin, request }) {
	if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some(key => !["accountId","projectId","bridgeId"].includes(key)) || ![request.accountId,request.projectId].every(v => typeof v === "string" && v.length > 0 && v.length <= 256) || typeof request.bridgeId !== "string" || !/^control-[a-f0-9-]{36}$/.test(request.bridgeId)) throw new Error("Invalid UI control scope");
	const connection = await connectOwnedWindow(webContents,{ appOrigin });
	const timer = setTimeout(() => { void connection.close(); },10_000);
	try {
		const { page } = connection;
		const call = async method => page.evaluate(({ scope,method }) => {
			if ((window.__opencutAccountId ?? "local") !== scope.accountId || decodeURIComponent(location.pathname.split("/")[2] ?? "") !== scope.projectId) throw new Error("UI scope changed");
			const service = window.__opencutEditorUiControl;
			if (!service || service.bridgeId !== scope.bridgeId) throw new Error("UI dispatch expired or cancelled");
			return service[method]();
		},{ scope:request,method });
		const plan = await call("prepare");
		if (!plan || !Number.isFinite(plan.x) || !Number.isFinite(plan.y) || plan.x < 0 || plan.y < 0 || plan.x > 8192 || plan.y > 8192) throw new Error("UI target bounds invalid");
		const gesture = plan.gesture;
		const target = page.locator(`[data-opencut-ui-target="${request.bridgeId}"]`);
		if (await target.count() !== 1) throw new Error("UI dispatch target is ambiguous");
		await call("prepare");
		switch (gesture.type) {
			case "focus": case "scroll": await call("passive"); break;
			case "click": await target.click({timeout:3000}); break;
			case "fill":
				if (typeof gesture.text !== "string" || gesture.text.length > 2000) throw new Error("UI text exceeds its bound");
				await call("focus"); await call("assertFocused"); await page.keyboard.press("ControlOrMeta+A");
				await call("assertFocused"); await page.keyboard.press("Backspace");
				await call("assertFocused"); await page.keyboard.insertText(gesture.text); break;
			case "key":
				if (!["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","Enter","Escape","Backspace","Delete"].includes(gesture.key)) throw new Error("UI key is unavailable");
				await call("focus"); await call("assertFocused"); await page.keyboard.press(gesture.key); break;
			case "drag":
				if (![gesture.x,gesture.y].every(v => Number.isInteger(v) && Math.abs(v) <= 1000)) throw new Error("UI drag exceeds its bound");
				await page.mouse.move(plan.x,plan.y); await call("prepare"); await page.mouse.down();
				for (let step=1;step<=8;step++) { await call("prepare"); await page.mouse.move(plan.x+gesture.x*step/8,plan.y+gesture.y*step/8); }
				await call("prepare"); await page.mouse.up(); break;
			default: throw new Error("UI gesture is unavailable");
		}
		await call("finish");
	} finally { clearTimeout(timer); await connection.close(); }
}
module.exports = { controlOwnedEditor };
