"use client";

import type { ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { Message } from "@/i18n/message";

/** Clickable and keyboard-accessible disclosure for supplementary settings help. */
export function SettingsInfo({
	children,
	label = "More information",
}: {
	children: ReactNode;
	label?: string;
}) {
	return (
		<details className="group text-xs text-muted-foreground">
			<summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
				<CircleHelp aria-hidden="true" size={15} />
				<span className={label === "More information" ? "sr-only" : undefined}>
					<Message text={label} />
				</span>
			</summary>
			<div className="mt-2 space-y-2 rounded-md border p-3">{children}</div>
		</details>
	);
}
