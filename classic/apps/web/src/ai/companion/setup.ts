import { z } from "zod";

export const COMPANION_URL = "http://127.0.0.1:43127";
export const CONTROL_PATH = "/internal/companion/control";
export const SETUP_PATH = "/api/companion/setup";
export const SETUP_HEADER = "X-POCUT-Setup";
export const SETUP_LIFETIME_MS = 30 * 60_000;

const exactHttpsOrigin = z
	.string()
	.url()
	.refine((value) => {
		if (!URL.canParse(value)) return false;
		const url = new URL(value);
		return url.origin === value && url.protocol === "https:";
	}, "Pairing requires an exact HTTPS app origin");

export const pairingSchema = z
	.object({
		version: z.literal(1),
		origin: exactHttpsOrigin,
		accountId: z.string().uuid(),
		token: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

export const companionSetupSchema = z
	.object({
		version: z.literal(1),
		origin: exactHttpsOrigin,
		setupId: z.string().uuid(),
		expiresAt: z.number().int().positive(),
	})
	.strict();

export type CompanionSetup = z.infer<typeof companionSetupSchema>;
