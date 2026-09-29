import { withAccount } from "@/accounts/server";
import { handleDeviceLogin } from "@/ai/server/device-login";
import type { NextRequest } from "next/server";
export const runtime = "nodejs";
export const POST = withAccount((request: NextRequest) =>
	handleDeviceLogin(request),
);
