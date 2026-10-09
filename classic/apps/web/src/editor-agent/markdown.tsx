import {
	Children,
	createElement,
	isValidElement,
	type HTMLAttributes,
	type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Visu's visual direction rule: count letters, exclude numbers/punctuation,
 * and resolve ties using the first letter. This is presentation only. */
export function messageDirection(text: string): "rtl" | "ltr" {
	let rtl = 0;
	let ltr = 0;
	let first: "rtl" | "ltr" | undefined;
	for (const letter of text) {
		if (!/\p{L}/u.test(letter)) continue;
		const direction = /[\p{Script=Hebrew}\p{Script=Arabic}]/u.test(letter)
			? "rtl"
			: "ltr";
		first ??= direction;
		if (direction === "rtl") rtl++;
		else ltr++;
	}
	return rtl === ltr ? (first ?? "ltr") : rtl > ltr ? "rtl" : "ltr";
}
function textOf(children: ReactNode): string {
	return Children.toArray(children)
		.map((child) =>
			typeof child === "string" || typeof child === "number"
				? String(child)
				: isValidElement<{ children?: ReactNode }>(child)
					? textOf(child.props.children)
					: "",
		)
		.join("");
}
const directed = (tag: string) =>
	function Directed({
		children,
		node: _node,
		...props
	}: HTMLAttributes<HTMLElement> & { node?: unknown; start?: number }) {
		return createElement(
			tag,
			{ ...props, dir: messageDirection(textOf(children)) },
			children,
		);
	};
const components: Components = {
	p: directed("p"),
	h1: directed("h1"),
	h2: directed("h2"),
	h3: directed("h3"),
	h4: directed("h4"),
	h5: directed("h5"),
	h6: directed("h6"),
	li: directed("li"),
	ul: directed("ul"),
	ol: directed("ol"),
	blockquote: directed("blockquote"),
	table: directed("table"),
	th: directed("th"),
	td: directed("td"),
	pre: ({ children }) => <pre dir="ltr">{children}</pre>,
	code: ({ children, className }) => (
		<code className={className} dir="ltr">
			{children}
		</code>
	),
	a: ({ children, href }) =>
		href ? (
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				dir={messageDirection(textOf(children))}
			>
				{children}
			</a>
		) : (
			<span>{children}</span>
		),
};
export function AgentMarkdown({ children }: { children: string }) {
	return (
		<ReactMarkdown
			skipHtml
			remarkPlugins={[remarkGfm]}
			disallowedElements={["img"]}
			components={components}
		>
			{children}
		</ReactMarkdown>
	);
}
