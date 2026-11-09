import { LocalizedElement as UiLocalized } from "@/i18n/message";
import Image from "next/image";
import Link from "next/link";
import { cn } from "@/utils/ui";
import styles from "./pocut-brand.module.css";

export function PocutWordmark({ className }: { className?: string }) {
	return (
		<UiLocalized<typeof Link>
			element={Link}
			messageProps={["aria-label"]}
			href="/"
			aria-label="POCUT home"
			className={cn(styles.wordmark, className)}
		>
			<Image src="/pocut/mark.svg" width={36} height={36} alt="" />
			<span>
				POCUT<span className={styles.period}>.</span>
			</span>
		</UiLocalized>
	);
}
