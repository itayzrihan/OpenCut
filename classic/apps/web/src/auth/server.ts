import { betterAuth, type RateLimit } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { Redis } from "@upstash/redis";
import { getDb } from "@/db";
import { webEnv } from "@/env/web";

export function createHostedAuth() {
if (!webEnv.DATABASE_URL || !webEnv.BETTER_AUTH_SECRET || !webEnv.UPSTASH_REDIS_REST_URL || !webEnv.UPSTASH_REDIS_REST_TOKEN) throw new Error("Hosted authentication is not configured. Use local accounts.");
const redis = new Redis({
	url: webEnv.UPSTASH_REDIS_REST_URL,
	token: webEnv.UPSTASH_REDIS_REST_TOKEN,
});

return betterAuth({
	database: drizzleAdapter(getDb(), {
		provider: "pg",
		usePlural: true,
	}),
	secret: webEnv.BETTER_AUTH_SECRET,
	user: {
		deleteUser: {
			enabled: true,
		},
	},
	emailAndPassword: {
		enabled: true,
	},
	rateLimit: {
		storage: "secondary-storage",
		customStorage: {
			get: async (key) => {
				const value = await redis.get(key);
				return value as RateLimit | undefined;
			},
			set: async (key, value) => {
				await redis.set(key, value);
			},
		},
	},
	baseURL: webEnv.NEXT_PUBLIC_SITE_URL,
	appName: "OpenCut",
	trustedOrigins: [webEnv.NEXT_PUBLIC_SITE_URL],
});
}
export type Auth = ReturnType<typeof createHostedAuth>;
