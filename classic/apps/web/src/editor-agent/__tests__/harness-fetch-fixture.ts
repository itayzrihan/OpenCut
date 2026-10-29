/** Route harness traffic through the real server loop while a fixture supplies
 * provider/knowledge responses. No network, accounts or credentials are read. */
export async function harnessFixtureResponse({ init }: { init?: RequestInit }) {
	const { accountScope } = await import("@/accounts/server");
	const { handleHarnessRequest } = await import("../server/harness-handler");
	return accountScope.run(
		{ id: "local", displayName: "Fixture", login: "fixture" },
		() =>
			handleHarnessRequest(
				new Request("http://127.0.0.1/api/editor-agent/harness", init),
			),
	);
}
