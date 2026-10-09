/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- ESTree and isolated GSAP page adapter boundaries; runtime checks precede mutation. */
import { parseGsapScriptAcornForWrite } from "@hyperframes/core/gsap-parser-acorn";
import type { HyperframesLayerMovePlan } from "./types";

type Node = {
	type?: string;
	name?: string;
	value?: unknown;
	computed?: boolean;
	left?: Node;
	right?: Node;
	object?: Node;
	property?: Node;
	callee?: Node;
	arguments?: Node[];
	params?: Node[];
	body?: Node | Node[];
	expression?: Node;
	argument?: Node;
	[key: string]: unknown;
};

// Generated and authored clips may use helpers, loops, computed starts and DOM references.
// Only a GSAP clock is supported. A custom seek hook must delegate to that
// timeline without changing DOM or using a second author-defined clock.
function delegatesSeek({
	node,
	timelines,
}: {
	node: Node | undefined;
	timelines: Set<string>;
}): boolean {
	if (
		!node ||
		!["ArrowFunctionExpression", "FunctionExpression"].includes(node.type ?? "")
	)
		return false;
	const param = node.params?.[0];
	if (node.params?.length !== 1 || param?.type !== "Identifier") return false;
	let body = node.body as Node | undefined;
	if (body?.type === "BlockStatement") {
		const statements = body.body as Node[];
		if (statements.length !== 1) return false;
		body = statements[0].expression ?? statements[0].argument;
	}
	if (
		body?.type !== "CallExpression" ||
		body.callee?.property?.name !== "seek" ||
		body.callee.computed ||
		body.arguments?.length !== 2 ||
		body.arguments[0].name !== param.name ||
		body.arguments[1].value !== false
	)
		return false;
	const pause = body.callee.object;
	return (
		pause?.type === "CallExpression" &&
		pause.callee?.property?.name === "pause" &&
		!pause.callee.computed &&
		pause.arguments?.length === 0 &&
		timelines.has(pause.callee.object?.name ?? "")
	);
}

export function compileGeneratedHyperframesLayerMove(
	plan: HyperframesLayerMovePlan,
): Record<string, string> {
	const parsed = plan.scripts
		.filter((script) => !script.runtimeLibrary)
		.map((script) => {
			const ast = parseGsapScriptAcornForWrite(script.content);
			if (!ast)
				throw new Error(`Cannot parse animation script ${script.file}.`);
			return ast;
		});
	const timelines = new Set(
		parsed.filter((ast) => ast.hasTimeline).map((ast) => ast.timelineVar),
	);
	if (!timelines.size)
		throw new Error(
			"Runtime layer timing requires a registered GSAP timeline.",
		);
	for (const ast of parsed) {
		const pending: unknown[] = [ast.ast];
		while (pending.length) {
			const value = pending.pop();
			if (!value || typeof value !== "object") continue;
			if (Array.isArray(value)) {
				pending.push(...value);
				continue;
			}
			const node = value as Node;
			if (
				node.type === "AssignmentExpression" &&
				(node.left?.property?.name ?? node.left?.property?.value) ===
					"__seekRender" &&
				!delegatesSeek({ node: node.right, timelines })
			)
				throw new Error(
					"This layer uses a custom seek clock. Edit its source timing instead.",
				);
			if (
				node.type === "AssignmentExpression" &&
				["window", "globalThis"].includes(node.left?.object?.name ?? "") &&
				node.left?.computed &&
				typeof node.left.property?.value !== "string"
			)
				throw new Error("Computed global hooks require source editing.");
			// Rust identifies supported vendor bytes by digest. Every author
			// script is checked, including scripts without a timeline declaration.
			if (node.type === "CallExpression") {
				const method =
					node.callee?.name ??
					node.callee?.property?.name ??
					node.callee?.property?.value;
				if (
					[
						"requestAnimationFrame",
						"requestVideoFrameCallback",
						"setTimeout",
						"setInterval",
						"addEventListener",
						"then",
						"animate",
						"getContext",
						"defineProperty",
						"registerEase",
					].includes(String(method)) ||
					(method === "add" && node.callee?.object?.property?.name === "ticker")
				)
					throw new Error(
						"Runtime layer timing cannot move asynchronous or non-GSAP animation. Edit its source instead.",
					);
			}
			for (const [key, child] of Object.entries(node))
				if (!["loc", "start", "end"].includes(key)) pending.push(child);
		}
	}
	const scripts = Object.fromEntries(
		plan.scripts.map((script) => [script.key, script.content]),
	);
	const tail = plan.scripts.at(-1);
	if (!tail || tail.content !== "" || tail.startByte === null)
		throw new Error("The layer move is missing its canonical script slot.");
	const input = {
		key: plan.layerKey,
		id: plan.elementId,
		from: plan.startSeconds - plan.deltaSeconds,
		to: plan.startSeconds,
		duration: plan.durationSeconds,
	};
	scripts[tail.key] =
		`;(${applyGeneratedLayerMove.toString()})(${JSON.stringify(input).replace(/</g, "\\u003c")});`;
	return scripts;
}

/** Serialized into the derived source tail. Uses only the actual GSAP objects
 * after authored construction; no second player or project state is created. */
function applyGeneratedLayerMove(input: {
	key: string;
	id: string;
	from: number;
	to: number;
	duration: number;
}): void {
	type Tween = {
		targets?: () => unknown[];
		startTime: (value?: number) => number;
		duration: () => number;
		endTime: () => number;
		vars: Record<string, unknown>;
	};
	type Timeline = Tween & {
		getChildren: (
			nested: boolean,
			tweens: boolean,
			timelines: boolean,
		) => Tween[];
		timeScale: () => number;
		repeat: () => number;
	};
	const page = window as unknown as {
		__timelines?: Record<string, Timeline>;
		__opencutLayerMoveError?: string;
		gsap?: {
			globalTimeline: Timeline;
			parseEase: () => Record<string, unknown>;
		};
	};
	try {
		if (page.__opencutLayerMoveError)
			throw new Error(page.__opencutLayerMoveError);
		let target: Element | undefined = document.documentElement;
		for (const part of input.key.slice(4).split("/"))
			target = target?.children[Number(part)];
		if (
			!target ||
			(target.id || target.getAttribute("data-hf-id")) !== input.id ||
			Array.from(document.querySelectorAll("[id], [data-hf-id]")).filter(
				(node) => (node.id || node.getAttribute("data-hf-id")) === input.id,
			).length !== 1
		)
			throw new Error("The layer identity changed.");
		const startAttribute = target.getAttribute("data-start");
		const durationAttribute = target.getAttribute("data-duration");
		const endAttribute = target.getAttribute("data-end");
		const start = Number(startAttribute),
			duration = Number(durationAttribute);
		if (
			!startAttribute?.trim() ||
			!durationAttribute?.trim() ||
			!Number.isFinite(start) ||
			!Number.isFinite(duration) ||
			(endAttribute !== null &&
				(!endAttribute.trim() ||
					!Number.isFinite(Number(endAttribute)) ||
					Math.abs(Number(endAttribute) - start - duration) > 1e-6)) ||
			Math.abs(start - input.from) > 1e-6 ||
			Math.abs(duration - input.duration) > 1e-6
		)
			throw new Error("The layer timing changed.");
		const composition = target.closest("[data-composition-id]");
		if (
			!composition ||
			composition.parentElement?.closest("[data-composition-id]")
		)
			throw new Error("Nested composition clocks require source editing.");
		if (
			target.querySelector(
				"[data-start], [data-duration], [data-end], [data-composition-id], [data-composition-src], animate, animateMotion, animateTransform, set, video, audio, canvas, iframe, template",
			)
		)
			throw new Error("This layer contains another timing or media clock.");
		const timelines = [...new Set(Object.values(page.__timelines ?? {}))];
		if (timelines.length !== 1)
			throw new Error(
				"Runtime layer timing requires one registered GSAP timeline.",
			);
		const timeline = timelines[0];
		if (timeline.timeScale() !== 1 || timeline.repeat() !== 0)
			throw new Error("Repeated or scaled timelines require source editing.");
		const hasCallbacks = (vars: Record<string, unknown>) =>
			Object.keys(vars).some(
				(key) =>
					/^on(?:Start|Update|Complete|ReverseComplete|Repeat|Interrupt)$/.test(
						key,
					) && vars[key],
			);
		if (hasCallbacks(timeline.vars))
			throw new Error("Timeline callbacks require source editing.");
		const knownEases = new Set(Object.values(page.gsap?.parseEase() ?? {}));
		const hasComputedValues = (vars: Record<string, unknown>) => {
			const pending: unknown[] = [vars];
			const seen = new Set<unknown>();
			while (pending.length) {
				const value = pending.pop();
				if (typeof value === "function") return true;
				if (!value || typeof value !== "object" || seen.has(value)) continue;
				seen.add(value);
				// GSAP attaches its parent timeline to vars. Inspect only authored
				// values, arrays and plain options, not engine or DOM instances.
				if (Array.isArray(value)) pending.push(...value);
				else if (Object.getPrototypeOf(value) === Object.prototype) {
					for (const [key, entry] of Object.entries(value)) {
						// GSAP installs its default ease function in zero-time sets.
						if (key === "ease" && knownEases.has(entry)) continue;
						pending.push(entry);
					}
				}
			}
			return false;
		};
		const changes: Array<{ tween: Tween; start: number }> = [];
		const registered = timeline.getChildren(false, true, true);
		for (const tween of registered) {
			const targets = tween.targets?.();
			if (
				!targets?.length ||
				targets.some((node) => !(node instanceof Element)) ||
				hasComputedValues(tween.vars)
			)
				throw new Error(
					"Nested timelines, computed tween values, callbacks or non-DOM animation require source editing.",
				);
			const count = targets.filter(
				(node) => node === target || target.contains(node as Element),
			).length;
			if (!count) continue;
			if (count !== targets.length)
				throw new Error("This animation is shared with another layer.");
			const start = tween.startTime();
			// A zero-time set establishes the initial pose. The clip visibility
			// window moves, while this initialization remains at the clock origin.
			if (start === 0 && tween.duration() === 0) continue;
			const next = start + input.to - input.from;
			if (!Number.isFinite(next) || next < 0)
				throw new Error("The move puts animation before time zero.");
			changes.push({ tween, start: next });
		}
		for (const tween of page.gsap?.globalTimeline.getChildren(
			true,
			true,
			false,
		) ?? []) {
			if (
				tween.duration() &&
				!registered.includes(tween) &&
				tween
					.targets?.()
					.some(
						(node) =>
							node instanceof Element &&
							(node === target || target.contains(node)),
					)
			)
				throw new Error("Off-timeline animation requires source editing.");
		}
		if (!changes.length)
			throw new Error("No owned GSAP animation was found for this layer.");
		// All ownership and clock checks finish before the first mutation.
		for (const change of changes) change.tween.startTime(change.start);
		target.setAttribute("data-start", String(input.to));
		if (target.hasAttribute("data-end"))
			target.setAttribute("data-end", String(input.to + input.duration));
	} catch (error) {
		page.__opencutLayerMoveError =
			error instanceof Error ? error.message : String(error);
		throw error;
	}
}
