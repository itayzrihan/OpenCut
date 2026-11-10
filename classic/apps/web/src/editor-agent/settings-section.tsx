"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Message } from "@/i18n/message";
import styles from "./overlay.module.css";

/** Presentation only: every section starts closed; the settings pane owns scrolling. */
export function AgentSettingsSection({
	title,
	children,
	revealRequest = 0,
}: {
	title: string;
	children: ReactNode;
	revealRequest?: number;
}) {
	const id = useId();
	const [state, setState] = useState({ request: 0, expanded: false });
	const expanded =
		state.request === revealRequest ? state.expanded : revealRequest > 0;
	return (
		<section className={styles.settingsSection}>
			<button
				type="button"
				className={styles.settingsHeading}
				aria-expanded={expanded}
				aria-controls={id}
				onClick={() =>
					setState({ request: revealRequest, expanded: !expanded })
				}
			>
				<Message text={title} />
				<ChevronDown
					aria-hidden="true"
					size={16}
					className={expanded ? styles.settingsChevronOpen : undefined}
				/>
			</button>
			<div id={id} hidden={!expanded} className={styles.settingsContent}>
				{children}
			</div>
		</section>
	);
}
