"use client";

import { useCallback, useEffect, useState } from "react";
import { aiClientFetch } from "@/ai/client-transport";
import { openAgentSettings } from "@/editor-agent/settings-navigation";

export interface AiOAuthStatus {
	authenticated: boolean;
	identity: {
		accountId?: string;
		email?: string;
		chatgptPlanType?: string;
		profileName?: string;
	} | null;
	error?: string;
}

export function useAiOAuthStatus() {
	const [status, setStatus] = useState<AiOAuthStatus>({
		authenticated: false,
		identity: null,
	});
	const [isLoading, setIsLoading] = useState(true);

	const refresh = useCallback(async () => {
		setIsLoading(true);
		try {
			const response = await aiClientFetch({ path: "/api/ai/oauth/status" });
			const data: unknown = await response.json();
			const nextStatus = normalizeAiOAuthStatus(data);
			setStatus(nextStatus);
		} catch (error) {
			setStatus({
				authenticated: false,
				identity: null,
				error:
					error instanceof Error
						? error.message
						: "Failed to read AI login status",
			});
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		const timeoutId = window.setTimeout(() => {
			void refresh();
		}, 0);
		const changed = () => {
			void refresh();
		};
		window.addEventListener("opencut-ai-connected", changed);
		return () => {
			window.clearTimeout(timeoutId);
			window.removeEventListener("opencut-ai-connected", changed);
		};
	}, [refresh]);

	const login = useCallback(() => {
		openAgentSettings();
	}, []);

	return { status, isLoading, refresh, login };
}

function normalizeAiOAuthStatus(value: unknown): AiOAuthStatus {
	if (!isRecord(value)) {
		return { authenticated: false, identity: null };
	}
	return {
		authenticated: value.authenticated === true,
		identity: isRecord(value.identity)
			? {
					accountId:
						typeof value.identity.accountId === "string"
							? value.identity.accountId
							: undefined,
					email:
						typeof value.identity.email === "string"
							? value.identity.email
							: undefined,
					chatgptPlanType:
						typeof value.identity.chatgptPlanType === "string"
							? value.identity.chatgptPlanType
							: undefined,
					profileName:
						typeof value.identity.profileName === "string"
							? value.identity.profileName
							: undefined,
				}
			: null,
		error: typeof value.error === "string" ? value.error : undefined,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
