"use client";

import Link from "next/link";
import type { ComponentProps } from "react";

export function WorkspaceLink({
	href,
	...props
}: Omit<ComponentProps<typeof Link>, "href" | "onNavigate"> & {
	href: string;
}) {
	return (
		<Link
			{...props}
			href={href}
			prefetch={false}
			scroll={false}
			onNavigate={(event) => {
				event.preventDefault();
				if (
					props["aria-disabled"] === true ||
					props["aria-disabled"] === "true"
				)
					return;
				// Next observes native history changes and updates the active workspace panel.
				if (`${window.location.pathname}${window.location.search}` !== href)
					window.history.pushState(null, "", href);
			}}
		/>
	);
}
