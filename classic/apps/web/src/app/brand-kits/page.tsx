import { redirect } from "next/navigation";
import { BRAND_KITS_HREF } from "@/brand-kits/types";

export default function BrandKitsPage() {
	redirect(BRAND_KITS_HREF);
}
