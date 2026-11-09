import type { Metadata } from "next";
import { headers } from "next/headers";
import { PocutLanding } from "@/components/landing/pocut-landing";
import { authenticateAccountNavigation } from "@/accounts/server";
import { legitateClientId } from "@/accounts/legitate-server";
import { SITE_URL } from "@/site/brand";

export const metadata: Metadata = {
	alternates: { canonical: SITE_URL },
};

export default async function Home() {
	const account = await authenticateAccountNavigation(
		new Request("http://localhost", { headers: await headers() }),
	).catch(() => null);
	return (
		<PocutLanding
			signedIn={!!account}
			legitateConfigured={!!legitateClientId()}
			legitateOnly={process.env.OPENCUT_LEGITATE_ONLY === "true"}
			localReturnTo="/projects"
		/>
	);
}
