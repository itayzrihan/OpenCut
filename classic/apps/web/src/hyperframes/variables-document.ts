/** Install explicit OpenCut overrides before the pinned runtime creates scopes.
 * HyperFrames resolves host defaults into this table before executing nested
 * scripts. Apply the same explicit values to those scopes, so text bindings,
 * script initialization and CSS all receive the selected clip's values.
 */
export function installHyperframesVariables(
	values: Record<string, unknown>,
): void {
	const page = window as typeof window & {
		__hfVariables?: Record<string, unknown>;
		__hfVariablesByComp?: Record<string, Record<string, unknown>>;
	};
	page.__hfVariables = values;
	const override = (scope: Record<string, unknown>) => ({
		...scope,
		...values,
	});
	const wrap = (scopes: Record<string, Record<string, unknown>>) =>
		new Proxy(
			Object.fromEntries(
				Object.entries(scopes).map(([id, scope]) => [id, override(scope)]),
			),
			{
				set: (target, key, scope: Record<string, unknown>) =>
					Reflect.set(target, key, override(scope)),
			},
		);
	let scopes = wrap(page.__hfVariablesByComp ?? {});
	Object.defineProperty(page, "__hfVariablesByComp", {
		configurable: true,
		get: () => scopes,
		set: (next: Record<string, Record<string, unknown>>) => {
			scopes = wrap(next ?? {});
		},
	});
}

export function hyperframesVariablesScript(
	values: Record<string, unknown>,
): string {
	return `(${installHyperframesVariables.toString()})(JSON.parse(${JSON.stringify(JSON.stringify(values)).replace(/</g, "\\u003c")}));`;
}
