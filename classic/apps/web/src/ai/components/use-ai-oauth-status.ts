"use client";

import { useCallback, useEffect, useState } from "react";

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
	const [redirectError, setRedirectError] = useState<string | undefined>();
	const [isLoading, setIsLoading] = useState(true);

	const refresh = useCallback(async () => {
		setIsLoading(true);
		try {
			const response = await fetch("/api/ai/oauth/status");
			const data: unknown = await response.json();
			const nextStatus = normalizeAiOAuthStatus(data);
			if (nextStatus.authenticated) {
				setRedirectError(undefined);
			}
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
			setRedirectError(readAndClearOAuthRedirectError());
			void refresh();
		}, 0);
		return () => window.clearTimeout(timeoutId);
	}, [refresh]);

	const login = useCallback(() => {
		const returnTo = encodeURIComponent(window.location.href);
		window.location.href = `/api/ai/oauth/start?returnTo=${returnTo}`;
	}, []);

	const logout = useCallback(async () => {
		await fetch("/api/ai/oauth/logout", { method: "POST" });
		await refresh();
	}, [refresh]);

	return {
		status:
			redirectError && !status.authenticated
				? { ...status, error: redirectError }
				: status,
		isLoading,
		refresh,
		login,
		logout,
	};
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

function readAndClearOAuthRedirectError(): string | undefined {
	const url = new URL(window.location.href);
	const status = url.searchParams.get("ai_oauth");
	const error = url.searchParams.get("ai_oauth_error");
	if (!status && !error) return undefined;

	url.searchParams.delete("ai_oauth");
	url.searchParams.delete("ai_oauth_error");
	window.history.replaceState(
		window.history.state,
		"",
		`${url.pathname}${url.search}${url.hash}`,
	);
	return status === "error"
		? error || "OpenAI login failed. Please try again."
		: undefined;
}
