import { formatMessage, type MessageCatalog, type Translate } from "./locales";

let activeCatalog: MessageCatalog = {};

export function setClientMessageCatalog(catalog: MessageCatalog) {
	activeCatalog = catalog;
}

/** Imperative notifications use the same active dictionary as React views. */
// eslint-disable-next-line opencut/prefer-object-params -- Match the translation function's message and interpolation signature.
export const localizeClientMessage: Translate = (message, values) =>
	formatMessage({ catalog: activeCatalog, message, values });
