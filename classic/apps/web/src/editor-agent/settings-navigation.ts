"use client";

import { create } from "zustand";

/** Durable UI intent survives a lazy-mounted Agent. No project/editor state here. */
export const useAgentSettingsNavigation = create<{
	request: number;
	provider: "openai" | "openrouter" | "claude";
}>(() => ({ request: 0, provider: "openai" }));

export function openAgentSettings(
	provider: "openai" | "openrouter" | "claude" = "openai",
) {
	useAgentSettingsNavigation.setState((state) => ({
		request: state.request + 1,
		provider,
	}));
}
