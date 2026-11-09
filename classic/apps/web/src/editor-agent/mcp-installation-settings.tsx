"use client";

import {
	LocalizedElement as UiLocalized,
	Message as UiMessage,
} from "@/i18n/message";
import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { createMcpInstallationZip } from "@/mcp/install-bundle";
import { downloadBlob } from "@/utils/browser";

const installation = z.object({
	activation: z.string(),
	origin: z.url(),
	expiresAt: z.number(),
});

export function McpInstallationSettings({ projectId }: { projectId: string }) {
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	const [setup, setSetup] = useState<{
		code: string;
		expiresAt: number;
		port: string;
	} | null>(null);
	const operation = useRef<AbortController | null>(null);
	useEffect(() => () => operation.current?.abort(), []);
	useEffect(() => {
		if (!setup) return;
		const timer = setTimeout(
			() => setSetup(null),
			Math.max(0, setup.expiresAt - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [setup]);

	async function update(action: "issue" | "revoke") {
		if (operation.current) return;
		const account = window.__opencutAccountId;
		if (!account) return;
		const controller = new AbortController();
		operation.current = controller;
		setPending(true);
		setSetup(null);
		setMessage("");
		try {
			const response = await fetch("/api/editor-agent/mcp-install", {
				method: "POST",
				credentials: "same-origin",
				cache: "no-store",
				headers: {
					"Content-Type": "application/json",
					"X-OpenCut-Account": account,
				},
				body: JSON.stringify({ action, projectId }),
				signal: controller.signal,
			});
			const result: unknown = await response.json();
			if (!response.ok)
				throw new Error(z.object({ error: z.string() }).parse(result).error);
			if (action === "revoke") {
				setMessage("MCP access for this project was revoked.");
				return;
			}
			const { activation, origin, expiresAt } = installation.parse(result);
			const { code, zip } = await createMcpInstallationZip({
				payload: { activation, origin },
				signal: controller.signal,
			});
			controller.signal.throwIfAborted();
			if (window.__opencutAccountId !== account) return;
			const url = new URL(origin);
			downloadBlob({ blob: zip, filename: "POCUT-MCP.zip" });
			setSetup({
				code,
				expiresAt,
				port: url.port || (url.protocol === "https:" ? "443" : "80"),
			});
		} catch (error) {
			if (!controller.signal.aborted)
				setMessage(
					error instanceof Error ? error.message : "MCP installation failed.",
				);
		} finally {
			operation.current = null;
			if (!controller.signal.aborted) setPending(false);
		}
	}

	return (
		<UiLocalized<"section">
			element={"section"}
			messageProps={["aria-label"]}
			aria-label="MCP installation"
			className="space-y-2 border-b px-3 py-3"
		>
			<h3 className="text-sm font-semibold">
				<UiMessage text={"Install editor MCP"} />
			</h3>
			<p className="text-xs text-muted-foreground">
				<UiMessage
					text={
						"Grant an external agent editing access to this project. Keep it open in a local POCUT installation."
					}
				/>
			</p>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="outline"
					disabled={pending}
					onClick={() => void update("issue")}
				>
					<Download size={14} /> <UiMessage text={"Download MCP ZIP"} />
				</Button>
				<Button
					size="sm"
					variant="ghost"
					disabled={pending}
					onClick={() => void update("revoke")}
				>
					<UiMessage text={"Revoke MCP access"} />
				</Button>
			</div>
			{message && (
				<p role="status" className="text-xs">
					{message}
				</p>
			)}
			{setup && (
				<div
					data-editor-agent-private
					className="space-y-2 rounded-md border bg-background p-2 text-xs"
				>
					<p>
						<UiMessage
							text={
								"Enter this one-time code in the installer’s hidden prompt within 15 minutes. Keep it out of the agent chat."
							}
						/>
					</p>
					<code className="block break-all select-all">{setup.code}</code>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								void navigator.clipboard.writeText(setup.code).then(
									() =>
										setMessage(
											"Code copied. Paste it into the installer’s hidden prompt.",
										),
									() =>
										setMessage(
											"Select the code and paste it into the hidden prompt.",
										),
								);
							}}
						>
							<UiMessage text={"Copy code"} />
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setSetup(null)}>
							<UiMessage text={"Hide code"} />
						</Button>
					</div>
					<p>
						<UiMessage text={"POCUT port for a private SSH forward:"} />{" "}
						{setup.port}
						<UiMessage
							text={". Setup and cleanup instructions are in the ZIP."}
						/>
					</p>
				</div>
			)}
		</UiLocalized>
	);
}
