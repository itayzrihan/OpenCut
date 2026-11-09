import {
	LocalizedElement as UiLocalized,
	Message as UiMessage,
} from "@/i18n/message";
import Image from "next/image";
import { SITE_INFO } from "@/site/brand";
import brand from "./landing/pocut-brand.module.css";
import styles from "./workspace-loading.module.css";

/** A stable opening screen shared by account, project and editor initialization. */
export function WorkspaceLoading() {
	return (
		<UiLocalized<"main">
			element={"main"}
			messageProps={["aria-label"]}
			className={`${brand.theme} ${styles.screen}`}
			role="status"
			aria-live="polite"
			aria-busy="true"
			aria-label="Opening POCUT"
		>
			<div className={styles.content}>
				<div className={styles.mark}>
					<Image src={SITE_INFO.favicon} width={56} height={56} alt="" />
				</div>
				<p className={styles.wordmark}>
					POCUT<span>.</span>
				</p>
				<h1>
					<UiMessage text={"Opening your workspace"} />
				</h1>
				<p className={styles.description}>
					<UiMessage text={"Getting everything ready for your next edit."} />
				</p>
				<div aria-hidden="true" className={styles.track}>
					<div className={styles.playhead} />
				</div>
			</div>
		</UiLocalized>
	);
}
