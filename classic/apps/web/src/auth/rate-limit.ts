import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { webEnv } from "@/env/web";

const redis = webEnv.UPSTASH_REDIS_REST_URL && webEnv.UPSTASH_REDIS_REST_TOKEN ? new Redis({
	url: webEnv.UPSTASH_REDIS_REST_URL,
	token: webEnv.UPSTASH_REDIS_REST_TOKEN,
}) : null;

export const baseRateLimit = redis ? new Ratelimit({
	redis,
	limiter: Ratelimit.slidingWindow(100, "1 m"), // 100 requests per minute
	analytics: true,
	prefix: "rate-limit",
}) : null;
const localWindow = { startedAt: 0, count: 0 };

export async function checkRateLimit({ request }: { request: Request }) {
	if (!baseRateLimit) {
		if (Date.now() - localWindow.startedAt >= 60_000) { localWindow.startedAt = Date.now(); localWindow.count = 0; }
		const success = ++localWindow.count <= 100;
		return { success, limited: !success };
	}
	const ip = request.headers.get("x-forwarded-for") ?? "anonymous";
	try {
		const { success } = await baseRateLimit.limit(ip);
		return { success, limited: !success };
	} catch (error) {
		if (webEnv.NODE_ENV === "development") {
			console.warn("Rate limit check skipped:", error);
			return { success: true, limited: false };
		}
		throw error;
	}
}
