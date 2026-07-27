import { z } from "zod";

const webEnvSchema = z.object({
	// Node
	NODE_ENV: z.enum(["development", "production", "test"]),
	ANALYZE: z.string().optional(),
	NEXT_RUNTIME: z.enum(["nodejs", "edge"]).optional(),

	// Public
	NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
	NEXT_PUBLIC_MARBLE_API_URL: z.url(),

	// Server
	DATABASE_URL: z
		.string()
		.refine(
			(url) => url.startsWith("postgres://") || url.startsWith("postgresql://"),
			"DATABASE_URL must be a postgres:// or postgresql:// URL",
		),

	BETTER_AUTH_SECRET: z.string(),
	UPSTASH_REDIS_REST_URL: z.url(),
	UPSTASH_REDIS_REST_TOKEN: z.string(),
	MARBLE_WORKSPACE_KEY: z.string(),
	FREESOUND_CLIENT_ID: z.string(),
	FREESOUND_API_KEY: z.string(),
	WHISPER_CPP_BINARY_PATH: z.string().optional(),
	WHISPER_CPP_MODEL_PATH: z.string().optional(),
	WHISPER_CPP_FFMPEG_PATH: z.string().optional(),
	OPENAI_CODEX_OAUTH_CLIENT_ID: z
		.string()
		.default("app_EMoamEEZ73f0CkXaXp7hrann"),
	OPENAI_CODEX_OAUTH_CALLBACK_HOST: z
		.enum(["localhost", "127.0.0.1", "::1"])
		.default("localhost"),
	OPENAI_CODEX_RESPONSES_BASE_URL: z
		.url()
		.default("https://chatgpt.com/backend-api/codex"),
	OPENAI_CODEX_MODEL: z.string().default("gpt-5.6-sol"),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

export const webEnv = webEnvSchema.parse(process.env);
