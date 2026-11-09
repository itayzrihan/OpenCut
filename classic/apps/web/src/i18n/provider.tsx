"use client";

import {
	createContext,
	useContext,
	useEffect,
	useState,
	type ReactNode,
} from "react";
import { Direction } from "radix-ui";
import { localDriveRequest } from "@/services/local-drive/client";
import { setClientMessageCatalog } from "./client-messages";
import {
	defaultInterfaceLocale,
	formatMessage,
	interfaceDirection,
	interfaceLocalePreference,
	isInterfaceLocale,
	type InterfaceLocale,
	type MessageCatalog,
	type Translate,
} from "./locales";

const english = { locale: defaultInterfaceLocale, catalog: {} } as const;
const catalogs = {
	he: () => import("./catalogs/he.json"),
	ar: () => import("./catalogs/ar.json"),
	de: () => import("./catalogs/de.json"),
	ru: () => import("./catalogs/ru.json"),
};

type Dictionary = { locale: InterfaceLocale; catalog: MessageCatalog };
const InterfaceLanguage = createContext<{
	locale: InterfaceLocale;
	ready: boolean;
	t: Translate;
	saveLocale: (locale: InterfaceLocale) => Promise<void>;
}>({
	locale: "en",
	ready: false,
	t: (message, values) => formatMessage({ catalog: {}, message, values }),
	saveLocale: async () => {
		throw new Error("Interface settings are unavailable");
	},
});

async function dictionary(locale: InterfaceLocale): Promise<Dictionary> {
	return locale === "en"
		? english
		: { locale, catalog: (await catalogs[locale]()).default };
}

export function LocaleProvider({ children }: { children: ReactNode }) {
	const [current, setCurrent] = useState<Dictionary>(english);
	const [ready, setReady] = useState(false);
	useEffect(() => {
		const account = window.__opencutAccountId;
		let cancelled = false;
		async function restore() {
			try {
				if (!account) return;
				const preferences = await localDriveRequest<Record<string, string>>({
					operation: "preferences.list",
					scope: { accountId: account },
				});
				const saved = preferences[interfaceLocalePreference];
				if (!isInterfaceLocale(saved)) return;
				const restored = await dictionary(saved);
				if (!cancelled && window.__opencutAccountId === account)
					setCurrent(restored);
			} catch (error) {
				console.error("Could not load the saved interface language", error);
			} finally {
				if (!cancelled) setReady(true);
			}
		}
		void restore();
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		setClientMessageCatalog(current.catalog);
		document.documentElement.lang = current.locale;
		document.documentElement.dir = interfaceDirection(current.locale);
	}, [current]);

	async function saveLocale(locale: InterfaceLocale) {
		const account = window.__opencutAccountId;
		if (!ready || !account)
			throw new Error("Sign in to change the interface language");
		const selected = await dictionary(locale);
		if (window.__opencutAccountId !== account)
			throw new Error("The account changed");
		await localDriveRequest({
			operation: "preferences.put",
			payload: { key: interfaceLocalePreference, value: locale },
			scope: { accountId: account },
		});
		if (window.__opencutAccountId === account) setCurrent(selected);
	}

	return (
		<InterfaceLanguage.Provider
			value={{
				locale: current.locale,
				ready,
				// eslint-disable-next-line opencut/prefer-object-params -- Match the translation function's message and interpolation signature.
				t: (message, values) =>
					formatMessage({ catalog: current.catalog, message, values }),
				saveLocale,
			}}
		>
			<Direction.Provider dir={interfaceDirection(current.locale)}>
				{children}
			</Direction.Provider>
		</InterfaceLanguage.Provider>
	);
}

export function useInterfaceLanguage() {
	return useContext(InterfaceLanguage);
}
