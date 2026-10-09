import { z } from "zod";
export const uiControlRequest = z
	.object({
		projectId: z.string().min(1),
		expectedRevision: z.number().int().nonnegative(),
		snapshotId: z.string().min(1).max(80),
		targetId: z.string().min(1).max(80),
		gesture: z.discriminatedUnion("type", [
			z.object({ type: z.literal("focus") }).strict(),
			z.object({ type: z.literal("click") }).strict(),
			z
				.object({ type: z.literal("fill"), text: z.string().max(2000) })
				.strict(),
			z
				.object({
					type: z.literal("key"),
					key: z.enum([
						"ArrowUp",
						"ArrowDown",
						"ArrowLeft",
						"ArrowRight",
						"Home",
						"End",
						"Enter",
						"Escape",
						"Backspace",
						"Delete",
					]),
				})
				.strict(),
			z
				.object({
					type: z.literal("scroll"),
					x: z.number().int().min(-2000).max(2000),
					y: z.number().int().min(-2000).max(2000),
				})
				.strict(),
			z
				.object({
					type: z.literal("drag"),
					x: z.number().int().min(-1000).max(1000),
					y: z.number().int().min(-1000).max(1000),
				})
				.strict(),
		]),
	})
	.strict();
export type UiControlRequest = z.infer<typeof uiControlRequest>;
export type UiGesture = UiControlRequest["gesture"]["type"];
const surfaces = new WeakMap<Element, readonly UiGesture[]>();
/** Host-owned UI intent, never inferred from authored HTML. Use only for
 * presentation state: panel opening/filtering/layout. Document edits declare
 * a canonical capability instead. Binding disappears on unmount. */
export function bindEditorUiSurface({
	element,
	gestures,
}: {
	element: Element;
	gestures: readonly UiGesture[];
}) {
	const binding = [...gestures];
	surfaces.set(element, binding);
	return () => {
		if (surfaces.get(element) === binding) surfaces.delete(element);
	};
}
type Targets = {
	document: Document;
	root: HTMLElement;
	accountId: string;
	projectId: string;
	revision: number;
	snapshotId: string;
	created: number;
	nodes: Map<string, Element>;
};
let targets: Targets | undefined;
export function opaqueUiIdentity(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 15) | 64;
	bytes[8] = (bytes[8] & 63) | 128;
	const hex = [...bytes]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function beginEditorUiTargets(
	input: Omit<Targets, "snapshotId" | "created" | "nodes">,
) {
	const snapshotId = `ui-${opaqueUiIdentity()}`;
	targets = { ...input, snapshotId, created: Date.now(), nodes: new Map() };
	return snapshotId;
}
export function addEditorUiTarget({
	element,
	snapshotId,
}: {
	element: Element;
	snapshotId: string;
}) {
	if (targets?.snapshotId !== snapshotId)
		throw new Error("UI observation was superseded");
	const targetId = `target-${targets.nodes.size + 1}`;
	targets.nodes.set(targetId, element);
	return {
		targetId,
		gestures: [
			...new Set<UiGesture>([
				"focus",
				"scroll",
				...(surfaces.get(element) ?? []),
			]),
		],
	};
}
const privateRegion =
	"[data-editor-agent-private], [data-testid='editor-agent'], iframe, object, embed, script, style, template, input[type='password'], input[type='hidden'], input[type='file']";
export function resolveEditorUiTarget({
	request,
	document,
	accountId,
	projectId,
	revision,
	signal,
}: {
	request: UiControlRequest;
	document: Document;
	accountId: string;
	projectId: string;
	revision: number;
	signal: AbortSignal;
}) {
	signal.throwIfAborted();
	const active = targets;
	const view = document.defaultView;
	if (
		!active ||
		!view ||
		(view.__opencutAccountId ?? "local") !== accountId ||
		!active.root.isConnected ||
		active.document !== document ||
		active.accountId !== accountId ||
		active.projectId !== projectId ||
		request.projectId !== projectId ||
		active.revision !== revision ||
		request.expectedRevision !== revision ||
		active.snapshotId !== request.snapshotId ||
		Date.now() - active.created > 60_000
	)
		throw new Error(
			"UI target expired or account, project, revision or snapshot changed; inspect again",
		);
	const element = active.nodes.get(request.targetId);
	if (
		!(element instanceof view.HTMLElement) ||
		!element.isConnected ||
		element.closest("[data-opencut-editor-project]") !== active.root ||
		active.root.dataset.opencutEditorProject !== projectId ||
		element.closest(privateRegion) ||
		element.matches(":disabled") ||
		element.closest(
			"[hidden], [inert], [aria-hidden='true'], [aria-disabled='true']",
		)
	)
		throw new Error("UI target is unavailable, disabled or private");
	for (
		let ancestor: Element | null = element;
		ancestor;
		ancestor = ancestor.parentElement
	) {
		const style = view.getComputedStyle(ancestor);
		if (
			style.display === "none" ||
			style.visibility !== "visible" ||
			Number(style.opacity) === 0
		)
			throw new Error("UI target is hidden");
	}
	const gesture = request.gesture;
	if (
		!["focus", "scroll"].includes(gesture.type) &&
		!surfaces.get(element)?.includes(gesture.type)
	)
		throw new Error(
			"This control requires its canonical capability; presentation gesture is not bound",
		);
	if (
		gesture.type === "fill" &&
		!(
			element instanceof view.HTMLInputElement &&
			["text", "search"].includes(element.type)
		) &&
		!(element instanceof view.HTMLTextAreaElement)
	)
		throw new Error("Only presentation search/text inputs accept fill");
	const rect = element.getBoundingClientRect();
	const x = rect.left + rect.width / 2,
		y = rect.top + rect.height / 2;
	const hit = document.elementFromPoint(x, y);
	if (
		rect.width <= 0 ||
		rect.height <= 0 ||
		!hit ||
		!(element === hit || element.contains(hit))
	)
		throw new Error(
			"UI target is clipped or covered; inspect the visible interface again",
		);
	if (gesture.type === "drag") {
		const root = active.root.getBoundingClientRect();
		if (
			x + gesture.x < Math.max(0, root.left) ||
			y + gesture.y < Math.max(0, root.top) ||
			x + gesture.x >= Math.min(view.innerWidth, root.right) ||
			y + gesture.y >= Math.min(view.innerHeight, root.bottom)
		)
			throw new Error("UI drag would leave the editor viewport");
	}
	return { element, view, x, y };
}
export function performBrowserUiGesture(
	input: Parameters<typeof resolveEditorUiTarget>[0],
) {
	const { element, view, x, y } = resolveEditorUiTarget(input);
	const gesture = input.request.gesture;
	switch (gesture.type) {
		case "focus":
			element.focus({ preventScroll: true });
			break;
		case "click":
			element.click();
			break;
		case "fill": {
			const prototype =
				element instanceof view.HTMLTextAreaElement
					? view.HTMLTextAreaElement.prototype
					: view.HTMLInputElement.prototype;
			const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
			if (!setter) throw new Error("UI input cannot be filled");
			setter.call(element, gesture.text);
			element.dispatchEvent(new view.Event("input", { bubbles: true }));
			element.dispatchEvent(new view.Event("change", { bubbles: true }));
			break;
		}
		case "key":
			element.focus({ preventScroll: true });
			element.dispatchEvent(
				new view.KeyboardEvent("keydown", {
					key: gesture.key,
					bubbles: false,
					cancelable: true,
				}),
			);
			element.dispatchEvent(
				new view.KeyboardEvent("keyup", { key: gesture.key, bubbles: false }),
			);
			break;
		case "scroll": {
			let scroll = element;
			while (
				scroll.parentElement &&
				scroll.dataset.opencutEditorProject === undefined &&
				scroll.scrollHeight <= scroll.clientHeight &&
				scroll.scrollWidth <= scroll.clientWidth
			)
				scroll = scroll.parentElement;
			scroll.scrollBy({ left: gesture.x, top: gesture.y, behavior: "instant" });
			break;
		}
		case "drag": {
			for (const [type, px, py, buttons] of [
				["pointerdown", x, y, 1],
				["pointermove", x + gesture.x, y + gesture.y, 1],
				["pointerup", x + gesture.x, y + gesture.y, 0],
			] as const) {
				input.signal.throwIfAborted();
				element.dispatchEvent(
					new view.PointerEvent(type, {
						clientX: px,
						clientY: py,
						button: 0,
						buttons,
						pointerId: 1,
						pointerType: "mouse",
						bubbles: true,
						cancelable: true,
					}),
				);
			}
			break;
		}
	}
	input.signal.throwIfAborted();
}
