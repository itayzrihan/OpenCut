import { PublicReviewView } from "@/client-review/public-view";
import type { Metadata } from "next";
export const metadata: Metadata = {
	title: "Client Preview · POCUT",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};
export default async function ReviewPage({
	params,
}: {
	params: Promise<{ token: string }>;
}) {
	return <PublicReviewView token={(await params).token} />;
}
