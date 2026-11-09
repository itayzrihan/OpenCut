export const ACCOUNT_WORKSPACE_HREF = "/projects?tab=account";

export function isAccountWorkspace({
	pathname,
	search,
}: {
	pathname: string;
	search: string;
}) {
	return (
		pathname === "/projects" &&
		new URLSearchParams(search).get("tab") === "account"
	);
}
