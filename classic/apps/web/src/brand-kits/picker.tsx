"use client";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { brandKitRequest } from "./client";
import type { BrandKit } from "./types";
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
				Brand Kit{" "}
				<span className="font-normal text-muted-foreground">· optional</span>
			</label>
			<select
				id={selectId}
				className="h-10 w-full rounded-md border bg-background px-3 text-sm"
				disabled={disabled || loading}
				value={value ?? ""}
				onChange={(event) => onChange(event.target.value || undefined)}
			>
				<option value="">
					{loading
						? "Loading Brand Kits…"
						: "No Brand Kit · default editing style"}
				</option>
				{kits.map((kit) => (
					<option key={kit.id} value={kit.id}>
						{kit.name}
					</option>
				))}
			</select>
			<p className="text-xs text-muted-foreground">
				Apply your logo, palette, fonts and closing phrase. Brand sounds follow
				the finishing steps you enable.{" "}
				<Link
					className="underline"
					href="/brand-kits"
					target="_blank"
					rel="noopener noreferrer"
				>
					Manage Brand Kits
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
					Refresh
				</button>
			</p>
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}
			{value && !loading && !kits.some((kit) => kit.id === value) && (
				<p role="alert" className="text-xs text-destructive">
					This kit is unavailable. Choose another kit or no Brand Kit.
				</p>
			)}
		</div>
	);
}
