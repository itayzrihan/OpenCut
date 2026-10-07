import {
	uiControlRequest,
	resolveEditorUiTarget,
	performBrowserUiGesture,
	opaqueUiIdentity,
	type UiControlRequest,
} from "./ui-targets";
export interface EditorUiControlService {
	bridgeId: string;
	prepare(): { x: number; y: number; gesture: UiControlRequest["gesture"] };
	focus(): void;
	assertFocused(): void;
	passive(): void;
	finish(): {
		projectId: string;
		revision: number;
		snapshotId: string;
		targetId: string;
		performed: true;
	};
}
declare global {
	interface Window {
		__opencutEditorUiControl?: EditorUiControlService;
	}
}
export async function controlEditorUi({
	request,
	accountId,
	projectId,
	currentRevision,
	signal,
}: {
	request: unknown;
	accountId: string;
	projectId: () => string | undefined;
	currentRevision: () => number | undefined;
	signal: AbortSignal;
}) {
	const input = uiControlRequest.parse(request);
	const scope = () => {
		signal.throwIfAborted();
		if (
			(window.__opencutAccountId ?? "local") !== accountId ||
			projectId() !== input.projectId ||
			currentRevision() !== input.expectedRevision
		)
			throw new Error("UI control account, project or revision changed");
	};
	const args = () => {
		scope();
		return {
			request: input,
			document: window.document,
			accountId,
			projectId: input.projectId,
			revision: input.expectedRevision,
			signal,
		};
	};
	const service: EditorUiControlService = {
		bridgeId: `control-${opaqueUiIdentity()}`,
		prepare() {
			const { x, y } = resolveEditorUiTarget(args());
			return { x, y, gesture: input.gesture };
		},
		focus() {
			const { element } = resolveEditorUiTarget(args());
			element.focus({ preventScroll: true });
		},
		assertFocused() {
			const { element } = resolveEditorUiTarget(args());
			if (window.document.activeElement !== element)
				throw new Error("UI focus changed before keyboard dispatch");
		},
		passive() {
			performBrowserUiGesture(args());
		},
		finish() {
			scope();
			return {
				projectId: input.projectId,
				revision: input.expectedRevision,
				snapshotId: input.snapshotId,
				targetId: input.targetId,
				performed: true,
			};
		},
	};
	service.prepare();
	const desktop = window.opencutElectron;
	if (!desktop) {
		service.passive();
		return { ...service.finish(), transport: "browserDom" };
	}
	if (window.__opencutEditorUiControl)
		throw new Error("Reconcile the active UI gesture first");
	const tagged = resolveEditorUiTarget(args()).element;
	const attribute = "data-opencut-ui-target";
	if (window.document.querySelector(`[${attribute}="${service.bridgeId}"]`))
		throw new Error("UI dispatch identity collision");
	tagged.setAttribute(attribute, service.bridgeId);
	window.__opencutEditorUiControl = service;
	try {
		await desktop.controlEditorUi({
			accountId,
			projectId: input.projectId,
			bridgeId: service.bridgeId,
		});
		return { ...service.finish(), transport: "ownedPlaywright" };
	} finally {
		if (tagged.getAttribute(attribute) === service.bridgeId)
			tagged.removeAttribute(attribute);
		if (window.__opencutEditorUiControl === service)
			delete window.__opencutEditorUiControl;
	}
}
