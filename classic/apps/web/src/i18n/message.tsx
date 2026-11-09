"use client";

import {
	createElement,
	type ComponentProps,
	type ElementType,
	type ReactNode,
} from "react";
import type { Translate } from "./locales";
import { useInterfaceLanguage } from "./provider";

export function Message({
	text,
	values,
}: {
	text: string;
	values?: Parameters<Translate>[1];
}) {
	return useInterfaceLanguage().t(text, values);
}

export function LocalizedValue({ children }: { children: ReactNode }) {
	const { t } = useInterfaceLanguage();
	return typeof children === "string" ? t(children) : children;
}

/** Translate only the named, author-supplied props. Other props stay intact. */
export function LocalizedElement<T extends ElementType>({
	element,
	messageProps,
	...props
}: ComponentProps<T> & {
	element: T;
	messageProps: readonly string[];
}) {
	const { t } = useInterfaceLanguage();
	const localized: Record<string, unknown> = { ...props };
	for (const name of messageProps) {
		const value = localized[name];
		if (typeof value === "string") localized[name] = t(value);
	}
	return createElement(element, localized);
}
