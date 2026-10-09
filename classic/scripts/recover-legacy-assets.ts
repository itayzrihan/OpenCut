// Usage: bun scripts/recover-legacy-assets.ts <legacy-owner-account-id> <old-public-directory>
// Copies missing library/font directories only. Existing account data is retained.
import { accountScope } from "../apps/web/src/accounts/server";
import { recoverMissingLegacyAssets } from "../apps/web/src/accounts/migration";
const [id, publicRoot] = process.argv.slice(2);
if (!id || !/^[a-f0-9-]{36}$/.test(id) || !publicRoot)
	throw new Error(
		"Usage: bun scripts/recover-legacy-assets.ts <legacy-owner-account-id> <old-public-directory>",
	);
console.log(
	await accountScope.run({ id, displayName: "", login: "" }, () =>
		recoverMissingLegacyAssets({ publicRoot }),
	),
);
