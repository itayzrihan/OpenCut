import { z } from "zod";
import { readCanonicalControl } from "@/core/canonical-control";
import { beginEditorUiTargets, addEditorUiTarget } from "./ui-targets";

const requestSchema = z
	.object({
		projectId: z.string().min(1),
		expectedRevision: z.number().int().nonnegative(),
		query: z.string().max(200).nullable().optional(),
		limit: z.number().int().min(1).max(200).default(80),
	})
	.strict();

const excluded =
	"[data-editor-agent-private], [data-testid='editor-agent'], iframe, object, embed, script, style, template, input[type='password'], input[type='hidden'], input[type='file']";
const roles: Readonly<Record<string, string>> = {
	BUTTON: "button",
	A: "link",
	SELECT: "combobox",
	TEXTAREA: "textbox",
	SUMMARY: "button",
	H1: "heading",
	H2: "heading",
	H3: "heading",
	H4: "heading",
	H5: "heading",
	H6: "heading",
	OUTPUT: "status",
};

/** Platform observation only. No event dispatch, selectors from model input,
 * input values, embedded documents or application state mutations. */
export function captureEditorUi({
	document,
	request,
	projectId,
}: {
	document: Document;
	request: unknown;
	projectId: string;
}) {
	const input = requestSchema.parse(request);
	if (input.projectId !== projectId) throw new Error("UI project changed");
	const roots = [
		...document.querySelectorAll<HTMLElement>("[data-opencut-editor-project]"),
	].filter((root) => root.dataset.opencutEditorProject === projectId);
	if (roots.length !== 1)
		throw new Error("The active editor root is unavailable or ambiguous");
	const root = roots[0];
	const view = document.defaultView;
	if (!view || !root.isConnected)
		throw new Error("The editor window is unavailable");
	const snapshotId = beginEditorUiTargets({
		document,
		root,
		accountId: view.__opencutAccountId ?? "local",
		projectId,
		revision: input.expectedRevision,
	});
	const isExcluded = (element: Element) =>
		!!element.closest(excluded) ||
		element.closest("[data-opencut-editor-project]") !== root ||
		!!element.parentElement?.closest("textarea, [contenteditable]");
	const isHidden = (element: Element) => {
		if (element.closest("[hidden], [aria-hidden='true'], [inert]")) return true;
		for (
			let ancestor: Element | null = element;
			ancestor;
			ancestor = ancestor.parentElement
		) {
			const style = view.getComputedStyle(ancestor);
			if (
				style.display === "none" ||
				style.visibility === "hidden" ||
				style.visibility === "collapse" ||
				Number(style.opacity) === 0
			)
				return true;
		}
		return false;
	};
	const text = (element: Element): string => {
		if (
			!root.contains(element) ||
			isExcluded(element) ||
			isHidden(element) ||
			element.matches("input, textarea, select, [contenteditable]")
		)
			return "";
		let visited = 0;
		let exhausted = false;
		const walker = document.createTreeWalker(element, 1 | 4, {
			acceptNode(node) {
				if (visited === 512) {
					exhausted = true;
					return 1;
				}
				visited++;
				if (
					node.nodeType === 1 &&
					node instanceof view.Element &&
					(node.matches(
						excluded + ", input, textarea, select, [contenteditable]",
					) ||
						isHidden(node))
				)
					return 2;
				return 1;
			},
		});
		let value = "";
		while (value.length < 240) {
			const node = walker.nextNode();
			if (!node || exhausted) break;
			if (node.nodeType === 3)
				value += (node.textContent ?? "").slice(0, 240 - value.length) + " ";
		}
		return value.replace(/\s+/g, " ").trim().slice(0, 240);
	};
	const label = (element: Element) => {
		const labelled = (element.getAttribute("aria-labelledby") ?? "")
			.split(/\s+/)
			.slice(0, 16)
			.map((id) => (id ? document.getElementById(id) : null))
			.filter((item): item is HTMLElement => !!item)
			.map(text)
			.join(" ")
			.trim();
		if (labelled) return labelled.slice(0, 240);
		const aria = element.getAttribute("aria-label")?.trim();
		if (aria) return aria.slice(0, 240);
		if (
			element instanceof view.HTMLInputElement ||
			element instanceof view.HTMLTextAreaElement ||
			element instanceof view.HTMLSelectElement
		) {
			const labels = [...(element.labels ?? [])].map(text).join(" ").trim();
			return (labels || element.getAttribute("title") || "").slice(0, 240);
		}
		return (
			element.hasAttribute("contenteditable")
				? (element.getAttribute("title") ?? "")
				: text(element) || element.getAttribute("title") || ""
		).slice(0, 240);
	};
	const bool = ({ element, name }: { element: Element; name: string }) => {
		const value = element.getAttribute(name);
		return value === "true" ? true : value === "false" ? false : null;
	};
	const nodes = [];
	const query = input.query?.trim().toLowerCase() ?? "";
	let scanned = 0;
	let exhausted = false;
	const walker = document.createTreeWalker(root, 1, {
		acceptNode(node) {
			// Count rejected nodes too: many private/embedded siblings must not
			// turn a bounded observation into an unbounded DOM traversal.
			if (scanned === 10_000) {
				exhausted = true;
				return 1;
			}
			scanned++;
			return node instanceof view.Element && isExcluded(node) ? 2 : 1;
		},
	});
	let truncated = false;
	while (true) {
		const element = walker.nextNode();
		if (!element) break;
		if (exhausted) {
			truncated = true;
			break;
		}
		if (!(element instanceof view.Element)) continue;
		let role =
			element.getAttribute("role")?.split(/\s+/)[0] ??
			roles[element.tagName] ??
			"";
		if (!role && element instanceof view.HTMLInputElement) {
			role =
				(
					{
						checkbox: "checkbox",
						radio: "radio",
						range: "slider",
						number: "spinbutton",
						button: "button",
						submit: "button",
					} as Readonly<Record<string, string>>
				)[element.type] ?? "textbox";
		}
		if (!role && element.hasAttribute("contenteditable")) role = "textbox";
		if (
			!role ||
			role === "none" ||
			role === "presentation" ||
			isHidden(element)
		)
			continue;
		const rect = element.getBoundingClientRect();
		if (
			rect.width <= 0 ||
			rect.height <= 0 ||
			rect.bottom <= 0 ||
			rect.right <= 0 ||
			rect.top >= view.innerHeight ||
			rect.left >= view.innerWidth
		)
			continue;
		// A control inside an unscrolled/clipped panel may still have a box in
		// the window. Intersect scroll ancestors before reporting it as visible.
		let left = Math.max(0, rect.left);
		let top = Math.max(0, rect.top);
		let right = Math.min(view.innerWidth, rect.right);
		let bottom = Math.min(view.innerHeight, rect.bottom);
		for (
			let parent = element.parentElement;
			parent;
			parent = parent.parentElement
		) {
			const style = view.getComputedStyle(parent);
			const bounds = parent.getBoundingClientRect();
			if (style.overflowX !== "visible") {
				left = Math.max(left, bounds.left);
				right = Math.min(right, bounds.right);
			}
			if (style.overflowY !== "visible") {
				top = Math.max(top, bounds.top);
				bottom = Math.min(bottom, bounds.bottom);
			}
		}
		if (left >= right || top >= bottom) continue;
		const name = label(element);
		if (query && !`${role} ${name}`.toLowerCase().includes(query)) continue;
		if (nodes.length === input.limit) {
			truncated = true;
			break;
		}
		nodes.push({
			...addEditorUiTarget({ element, snapshotId }),
			action: readCanonicalControl({
				element,
				accountId: view.__opencutAccountId ?? "local",
				projectId,
				revision: input.expectedRevision,
			}),
			role: role.slice(0, 80),
			name,
			disabled:
				element.matches(":disabled") ||
				!!element.closest("[aria-disabled='true']"),
			focused: document.activeElement === element,
			selected: bool({ element, name: "aria-selected" }),
			pressed: bool({ element, name: "aria-pressed" }),
			checked:
				element instanceof view.HTMLInputElement &&
				["checkbox", "radio"].includes(element.type)
					? element.checked
					: bool({ element, name: "aria-checked" }),
			expanded: bool({ element, name: "aria-expanded" }),
			bounds: {
				x: Math.round(rect.x),
				y: Math.round(rect.y),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
			},
		});
	}
	return {
		snapshotId,
		projectId,
		revision: input.expectedRevision,
		nodes,
		truncated,
		scanned,
	};
}
