import { toast as sonner } from "sonner";
import { localizeClientMessage } from "./client-messages";

function localize<T>(value: T): T | string {
	return typeof value === "string" ? localizeClientMessage(value) : value;
}

type Options = NonNullable<Parameters<typeof sonner>[1]>;

function localizeAction(action: Options["action"]): Options["action"] {
	return action &&
		typeof action === "object" &&
		"label" in action &&
		"onClick" in action
		? { ...action, label: localize(action.label) }
		: localize(action);
}

function withMessages(show: typeof sonner.success): typeof sonner.success {
	// eslint-disable-next-line opencut/prefer-object-params -- Preserve Sonner's public callback signature.
	return (message, options) =>
		show(
			localize(message),
			options && {
				...options,
				description: localize(options.description),
				action: localizeAction(options.action),
				cancel: localizeAction(options.cancel),
			},
		);
}

export const toast: typeof sonner = Object.assign(withMessages(sonner), {
	...sonner,
	success: withMessages(sonner.success),
	info: withMessages(sonner.info),
	warning: withMessages(sonner.warning),
	error: withMessages(sonner.error),
	message: withMessages(sonner.message),
	loading: withMessages(sonner.loading),
});
