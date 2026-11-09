import Link from "next/link";
import { Message as UiMessage } from "@/i18n/message";
import { legalRoutes, type LegalLanguage, type LegalPageId } from "./documents";

export function LegalLinks({
	current,
	language,
}: {
	current?: LegalPageId;
	language?: LegalLanguage;
}) {
	return Object.entries(legalRoutes).map(
		([id, { href, label, hebrewLabel }]) => (
			<Link
				key={id}
				href={language ? { pathname: href, query: { lang: language } } : href}
				aria-current={current === id ? "page" : undefined}
			>
				{language ? (
					language === "he" ? (
						hebrewLabel
					) : (
						label
					)
				) : (
					<UiMessage text={label} />
				)}
			</Link>
		),
	);
}
