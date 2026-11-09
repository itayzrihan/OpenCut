"use client";
import { LocalizedValue as UiValue } from "@/i18n/message";
import { Message as UiMessage } from "@/i18n/message";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { brandKitRequest } from "./client";
import { BRAND_KITS_HREF, type BrandKit } from "./types";
export function BrandKitPicker({
	value,
	onChange,
	disabled,
}: {
	value?: string;
	onChange: (id: string | undefined) => void;
	disabled?: boolean;
}) {
	const selectId = useId();
	const [kits, setKits] = useState<BrandKit[]>([]),
		[error, setError] = useState(""),
		[loading, setLoading] = useState(true);
	useEffect(() => {
		const controller = new AbortController();
		void brandKitRequest({ signal: controller.signal })
			.then((data) => {
				setKits(data.kits);
				setLoading(false);
			})
			.catch((error) => {
				if (!controller.signal.aborted) {
					setError(error.message);
					setLoading(false);
				}
			});
		return () => controller.abort();
	}, []);
	return (
		<div className="space-y-2 rounded-lg border p-3">
			<label className="block text-sm font-medium" htmlFor={selectId}>
				<UiMessage text={"Brand Kit"} />{" "}
				<span className="font-normal text-muted-foreground">
					<UiMessage text={"· optional"} />
				</span>
			</label>
			<select
				id={selectId}
				className="h-10 w-full rounded-md border bg-background px-3 text-sm"
				disabled={disabled || loading}
				value={value ?? ""}
				onChange={(event) => onChange(event.target.value || undefined)}
			>
				<option value="">
					{loading ? (
						<UiMessage text={"Loading Brand Kits…"} />
					) : (
						<UiMessage text={"No Brand Kit · default editing style"} />
					)}
				</option>
				{kits.map((kit) => (
					<option key={kit.id} value={kit.id}>
						{kit.name}
					</option>
				))}
			</select>
			<p className="text-xs text-muted-foreground">
				<UiMessage
					text={
						"Apply your logo, palette, fonts and closing phrase. Brand sounds follow the finishing steps you enable."
					}
				/>{" "}
				<Link
					className="underline"
					href={BRAND_KITS_HREF}
					target="_blank"
					rel="noopener noreferrer"
				>
					<UiMessage text={"Manage Brand Kits"} />
				</Link>
				{" · "}
				<button
					type="button"
					className="underline"
					disabled={disabled || loading}
					onClick={() => {
						setLoading(true);
						setError("");
						void brandKitRequest()
							.then((data) => setKits(data.kits))
							.catch((error) => setError(error.message))
							.finally(() => setLoading(false));
					}}
				>
					<UiMessage text={"Refresh"} />
				</button>
			</p>
			{error && (
				<p role="alert" className="text-xs text-destructive">
					<UiValue>{error}</UiValue>
				</p>
			)}
			{value && !loading && !kits.some((kit) => kit.id === value) && (
				<p role="alert" className="text-xs text-destructive">
					<UiMessage
						text={
							"This kit is unavailable. Choose another kit or no Brand Kit."
						}
					/>
				</p>
			)}
		</div>
	);
}
