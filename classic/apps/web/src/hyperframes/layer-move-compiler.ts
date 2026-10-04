import { parseGsapScriptAcornForWrite } from "@hyperframes/core/gsap-parser-acorn";
import {
	clipTweenMatcher,
	hasExplicitTime,
	shiftPositionsInScript,
} from "@hyperframes/core/gsap-writer-acorn";
import type { HyperframesLayerMovePlan } from "./types";
import { compileGeneratedHyperframesLayerMove } from "./generated-layer-move";

type AstNode = {
	type?: string;
	callee?: AstNode;
	object?: AstNode;
	property?: AstNode;
	name?: string;
	value?: unknown;
	arguments?: AstNode[];
	properties?: AstNode[];
	key?: AstNode;
	start?: number;
	end?: number;
	[key: string]: unknown;
};

/** Platform compiler adapter. Rust supplies the move, package ownership and HTML;
 * this adapter only invokes the pinned GSAP parser/writer on script bodies. */
export function compileHyperframesLayerMove({
	plan,
	document: parsedDocument,
}: {
	plan: HyperframesLayerMovePlan;
	document?: Document;
}): Record<string, string> {
	if (plan.strategy === "runtime")
		return compileGeneratedHyperframesLayerMove(plan);
	const document =
		parsedDocument ?? new DOMParser().parseFromString(plan.html, "text/html");
	const roots: ParentNode[] = [document];
	for (let i = 0; i < roots.length; i++) {
		for (const template of roots[i].querySelectorAll("template"))
			roots.push(template.content);
	}
	const matches = roots.flatMap((root) =>
		Array.from(root.querySelectorAll("[id], [data-hf-id]"))
			.filter(
				(node) =>
					node.id === plan.elementId ||
					node.getAttribute("data-hf-id") === plan.elementId,
			)
			.map((node) => ({ node, root })),
	);
	if (matches.length !== 1)
		throw new Error(
			"The layer's source identity changed while compiling its timing.",
		);
	const { node, root } = matches[0];
	const marker = "data-opencut-move-target";
	for (const previous of root.querySelectorAll(`[${marker}]`))
		previous.removeAttribute(marker);
	node.setAttribute(marker, "");
	const selector = `[${marker}]`;
	const carries = clipTweenMatcher(selector, root);
	const scripts: Record<string, string> = {};
	const parsedScripts = plan.scripts.map((script) => {
		const parsed = parseGsapScriptAcornForWrite(script.content);
		if (!parsed)
			throw new Error(
				`Cannot parse animation script ${script.file}. Edit its source instead.`,
			);
		return { script, parsed };
	});
	const timelineRoots = new Set(
		parsedScripts
			.filter(({ parsed }) => parsed.hasTimeline)
			.map(({ parsed }) => parsed.timelineVar),
	);
	for (const { script, parsed } of parsedScripts) {
		// The vendor writer detects one timeline and omits off-timeline tweens.
		// Diagnose those AST forms before accepting a seemingly unchanged body.
		let timelineCount = 0;
		const recognized = new Set<unknown>(
			parsed.located.map(({ call }) => call.node),
		);
		const pending: unknown[] = [parsed.ast];
		while (pending.length) {
			const value = pending.pop();
			if (!value || typeof value !== "object") continue;
			if (Array.isArray(value)) {
				pending.push(...value);
				continue;
			}
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ESTree adapter boundary.
			const ast = value as AstNode;
			if (
				ast.type === "CallExpression" &&
				ast.callee?.type === "MemberExpression" &&
				ast.callee.object?.name === "gsap"
			) {
				const method = ast.callee.property?.name;
				if (method === "timeline") {
					timelineCount++;
					const options = ast.arguments?.[0];
					if (
						options &&
						(options.type !== "ObjectExpression" ||
							options.properties?.some(
								(property) =>
									!["paused", "defaults"].includes(
										property.key?.name ?? String(property.key?.value),
									),
							))
					)
						throw new Error(
							"Timeline offsets, repeats or computed options require source editing.",
						);
				}
				if (["to", "from", "fromTo"].includes(method ?? ""))
					throw new Error("Off-timeline GSAP tweens require source editing.");
			}
			if (
				ast.type === "CallExpression" &&
				ast.callee?.type === "MemberExpression" &&
				ast.callee.property?.name === "animate"
			)
				throw new Error("Web Animations timing requires source editing.");
			if (
				ast.type === "CallExpression" &&
				ast.callee?.type === "MemberExpression"
			) {
				const method = ast.callee.property?.name ?? ast.callee.property?.value;
				let receiver = ast.callee.object;
				while (receiver?.type === "CallExpression")
					receiver = receiver.callee?.object;
				const receiverSource =
					receiver && script.content.slice(receiver.start, receiver.end);
				const onTimeline =
					receiverSource === parsed.timelineVar ||
					(!!receiverSource && timelineRoots.has(receiverSource));
				const selectorTarget =
					typeof ast.arguments?.[0]?.value === "string" ||
					ast.arguments?.[0]?.type === "ArrayExpression";
				const tween =
					(["to", "from", "fromTo"].includes(String(method)) &&
						(onTimeline || parsed.hasTimeline || selectorTarget)) ||
					(method === "set" &&
						(onTimeline || typeof ast.arguments?.[0]?.value === "string"));
				if (
					(tween && !recognized.has(ast)) ||
					(onTimeline && !recognized.has(ast))
				)
					throw new Error(
						`Unsupported or cross-file timeline call (${String(method)}) in ${script.file}. Edit its source to move the layer.`,
					);
			}
			for (const [key, child] of Object.entries(ast))
				if (!["loc", "start", "end"].includes(key)) pending.push(child);
		}
		if (timelineCount > 1)
			throw new Error(
				"This script contains multiple timelines. Edit its source to move the layer.",
			);
		for (const { animation, call } of parsed.located) {
			if (animation.global) continue;
			if (!parsed.hasTimeline)
				throw new Error(
					"The timeline declaration and its tweens must be in the same script.",
				);
			if (
				animation.hasPartialSelector ||
				animation.targetSelector === "__unresolved__"
			)
				throw new Error(
					"This animation builds its targets dynamically. Edit its source to move the layer.",
				);
			// Implicit/relative starts elsewhere can follow a moved tween. The
			// writer silently skips some of these; fail the entire compilation.
			if (
				!hasExplicitTime(animation) ||
				call.positionArg?.type !== "Literal" ||
				typeof call.positionArg.value !== "number"
			)
				throw new Error(
					"This animation uses linked or computed start times. Edit its source to move the layer.",
				);
			if (
				call.ancestors.some((ancestor: { type: string }) =>
					[
						"ForStatement",
						"ForInStatement",
						"ForOfStatement",
						"WhileStatement",
						"DoWhileStatement",
						"FunctionExpression",
						"ArrowFunctionExpression",
						"FunctionDeclaration",
					].includes(ancestor.type),
				)
			)
				throw new Error(
					"This animation builds a timeline in a function or loop. Edit its source to move the layer.",
				);
			let targets: Element[];
			try {
				targets = Array.from(root.querySelectorAll(animation.targetSelector));
			} catch {
				throw new Error(
					"An animation target cannot be resolved in this source file.",
				);
			}
			if (
				targets.some((target) => target === node || node.contains(target)) &&
				!carries(animation)
			)
				throw new Error(
					"An animation is shared with another layer. Edit its source before moving this layer.",
				);
			if (carries(animation) && animation.position + plan.deltaSeconds < 0)
				throw new Error(
					"This move would place part of the animation before time zero.",
				);
			if (carries(animation)) {
				const optionNodes: unknown[] = [call.varsArg, call.fromArg];
				for (const value of optionNodes) {
					if (!value || typeof value !== "object") continue;
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ESTree adapter boundary.
					const vars = value as AstNode;
					if (
						vars.type !== "ObjectExpression" ||
						vars.properties?.some(
							(property) =>
								property.type !== "Property" ||
								property.computed ||
								property.method ||
								/^on(?:Start|Update|Complete|ReverseComplete|Repeat|Interrupt)(?:Params)?$/.test(
									String(property.key?.name ?? property.key?.value),
								),
						)
					)
						throw new Error(
							"Tween callbacks or computed options require source editing.",
						);
				}
			}
			if (
				carries(animation) &&
				Math.abs(
					animation.position * 1000 - Math.round(animation.position * 1000),
				) > 1e-6
			)
				throw new Error(
					"This tween uses finer than millisecond timing. Edit its source to preserve that precision.",
				);
		}
		scripts[script.key] = shiftPositionsInScript(
			script.content,
			selector,
			plan.deltaSeconds,
			root,
		);
	}
	return scripts;
}
