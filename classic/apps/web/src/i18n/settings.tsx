"use client";

import { useId, useState } from "react";
import { Languages } from "lucide-react";
import styles from "@/accounts/settings.module.css";
import { interfaceLanguages, isInterfaceLocale } from "./locales";
import { useInterfaceLanguage } from "./provider";

export function LanguageSettings() {
	const id = useId();
	const { locale, ready, saveLocale, t } = useInterfaceLanguage();
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState(false);
	return (
		<section className={styles.card} aria-labelledby={id}>
			<h3 id={id} className={styles.heading}>
				<Languages className="size-4 text-primary" aria-hidden="true" />
				{t("Appearance and language")}
			</h3>
			<div className="grid max-w-sm gap-2 text-sm">
				<label htmlFor={`${id}-select`}>{t("Interface language")}</label>
				<select
					id={`${id}-select`}
					value={locale}
					aria-describedby={`${id}-description`}
					disabled={!ready || saving}
					className="h-10 w-full rounded-lg border bg-background px-3 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
					onChange={async (event) => {
						const next = event.currentTarget.value;
						if (!isInterfaceLocale(next)) return;
						setSaving(true);
						setFailed(false);
						try {
							await saveLocale(next);
						} catch {
							setFailed(true);
						} finally {
							setSaving(false);
						}
					}}
				>
					{Object.entries(interfaceLanguages).map(([code, name]) => (
						<option key={code} value={code} lang={code} dir="auto">
							{name}
						</option>
					))}
				</select>
			</div>
			<p id={`${id}-description`} className="text-sm text-muted-foreground">
				{t(
					"This choice is saved to your account and only changes the interface language.",
				)}
			</p>
			{saving && <p role="status">{t("Saving language…")}</p>}
			{failed && (
				<p role="alert">{t("Could not save the language. Try again.")}</p>
			)}
		</section>
	);
}
