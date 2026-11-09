import { redirect } from "next/navigation";
import { ACCOUNT_WORKSPACE_HREF } from "@/accounts/workspace-route";

export default function AccountPage() {
	redirect(ACCOUNT_WORKSPACE_HREF);
}
