export const interfaceLanguages = {
	en: "English",
	he: "עברית",
	ar: "العربية",
	de: "Deutsch",
	ru: "Русский",
} as const;

export type InterfaceLocale = keyof typeof interfaceLanguages;
export const defaultInterfaceLocale = "en";
export const interfaceLocalePreference = "pocut-interface-locale";

export function isInterfaceLocale(value: unknown): value is InterfaceLocale {
	return typeof value === "string" && Object.hasOwn(interfaceLanguages, value);
}

export function interfaceDirection(locale: InterfaceLocale) {
	return locale === "he" || locale === "ar" ? "rtl" : "ltr";
}

export type MessageCatalog = Readonly<Record<string, string>>;
type MessageValues = Readonly<Record<string, string | number>>;

export function formatMessage({
	catalog,
	message,
	values,
}: {
	catalog: MessageCatalog;
	message: string;
	values?: MessageValues;
}) {
	const translation = Object.hasOwn(catalog, message)
		? catalog[message]
		: message;
	return values
		? translation.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
				Object.hasOwn(values, key) ? String(values[key]) : placeholder,
			)
		: translation;
}

export type Translate = (message: string, values?: MessageValues) => string;
