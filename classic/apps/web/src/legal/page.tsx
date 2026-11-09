"use client";

import { PocutWordmark } from "@/components/landing/pocut-brand";
import brand from "@/components/landing/pocut-brand.module.css";
import { interfaceDirection } from "@/i18n/locales";
import { useInterfaceLanguage } from "@/i18n/provider";
import { cn } from "@/utils/ui";
import Link from "next/link";
import {
	legalReferences,
	legalRoutes,
	type LegalDocument,
	type LegalPageId,
} from "./documents";
import { englishLegal } from "./en";
import { hebrewLegal } from "./he";
import { LegalLinks } from "./links";
import styles from "./page.module.css";

export function LegalPage({
	id,
	requestedLanguage,
}: {
	id: LegalPageId;
	requestedLanguage?: string | string[];
}) {
	const { locale, t } = useInterfaceLanguage();
	const explicitLanguage =
		requestedLanguage === "en" || requestedLanguage === "he"
			? requestedLanguage
			: undefined;
	const language = explicitLanguage ?? (locale === "he" ? "he" : "en");
	const edition = language === "he" ? hebrewLegal : englishLegal;
	const document: LegalDocument = edition.documents[id];
	const sections = Object.entries(document.sections);
	const translateChrome =
		explicitLanguage === "en" ? (text: string) => text : t;
	const navigationLabel =
		explicitLanguage === "he"
			? "מידע משפטי ונגישות"
			: translateChrome("Legal and accessibility");
	const languageLabel =
		explicitLanguage === "he"
			? "שפת המסמך"
			: translateChrome("Document language");
	const skipLabel =
		explicitLanguage === "he"
			? "דילוג לתוכן"
			: translateChrome("Skip to content");

	return (
		<div
			className={cn(brand.theme, styles.page)}
			lang={explicitLanguage}
			dir={explicitLanguage && interfaceDirection(explicitLanguage)}
		>
			<a href="#legal-main" className={styles.skip}>
				{skipLabel}
			</a>
			<header className={styles.header}>
				<PocutWordmark />
				<nav aria-label={navigationLabel} className={styles.links}>
					<LegalLinks current={id} language={explicitLanguage} />
				</nav>
				<nav aria-label={languageLabel} className={styles.links}>
					<Link
						href={{ pathname: legalRoutes[id].href, query: { lang: "en" } }}
						lang="en"
						aria-current={language === "en" ? "true" : undefined}
					>
						English
					</Link>
					<Link
						href={{ pathname: legalRoutes[id].href, query: { lang: "he" } }}
						lang="he"
						aria-current={language === "he" ? "true" : undefined}
					>
						עברית
					</Link>
				</nav>
			</header>
			<main
				id="legal-main"
				tabIndex={-1}
				lang={language}
				dir={interfaceDirection(language)}
				className={styles.main}
			>
				<header className={styles.hero}>
					<span className={cn(brand.eyebrow, styles.badge)}>
						{edition.draft}
					</span>
					<h1>{document.title}</h1>
					<p>{document.description}</p>
				</header>
				<p className={styles.notice}>{edition.development}</p>
				<div className={styles.body}>
					<nav className={styles.toc} aria-labelledby="legal-contents">
						<p id="legal-contents">{edition.contents}</p>
						<ul>
							{sections.map(([sectionId, { heading }]) => (
								<li key={sectionId}>
									<a href={`#${sectionId}`}>{heading}</a>
								</li>
							))}
						</ul>
					</nav>
					<article className={styles.article}>
						{sections.map(([sectionId, { heading, paragraphs, items }]) => (
							<section key={sectionId} className={styles.section}>
								<h2 id={sectionId} tabIndex={-1}>
									{heading}
								</h2>
								{paragraphs?.map((paragraph) => (
									<p key={paragraph}>{paragraph}</p>
								))}
								{items && (
									<ul>
										{items.map((item) => (
											<li key={item}>{item}</li>
										))}
									</ul>
								)}
								{legalReferences[id]?.[sectionId]?.map(({ href, label }) => (
									<a
										key={href}
										href={href}
										lang="en"
										className={styles.reference}
									>
										{label}
									</a>
								))}
							</section>
						))}
					</article>
				</div>
			</main>
		</div>
	);
}
