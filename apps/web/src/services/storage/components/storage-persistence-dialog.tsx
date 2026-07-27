"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { getLocalDriveStatus } from "@/services/local-drive/client";

const DISMISSED_KEY = "pocut-local-drive-introduction-v1";

export function StoragePersistenceDialog() {
	const [rootPath, setRootPath] = useState<string | null>(null);
	const [open, setOpen] = useState(false);

	useEffect(() => {
		try {
			if (localStorage.getItem(DISMISSED_KEY) === "true") return;
		} catch {
			// The dialog is still useful if this browser blocks localStorage.
		}
		void getLocalDriveStatus()
			.then((status) => {
				setRootPath(status.rootPath);
				setOpen(true);
			})
			.catch(() => undefined);
	}, []);

	const dismiss = () => {
		setOpen(false);
		try {
			localStorage.setItem(DISMISSED_KEY, "true");
		} catch {
			// Dismiss for this page lifetime when localStorage is unavailable.
		}
	};

	return (
		<Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && dismiss()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Projects now live on your drive</DialogTitle>
				</DialogHeader>
				<DialogBody>
					<p className="text-base text-muted-foreground">
						Projects, undo history, media metadata, fonts, and saved sounds are
						stored in a normal local folder, shared by every browser that opens
						this local PoCut installation.
					</p>
					{rootPath ? (
						<code className="block rounded-md bg-muted px-3 py-2 text-sm break-all">
							{rootPath}
						</code>
					) : null}
					<p className="text-base text-muted-foreground">
						Media up to 1 GB is copied into its project. Larger media stays in
						place and PoCut stores a link to its absolute path, so moving or
						deleting the original file will make that media unavailable.
					</p>
				</DialogBody>
				<DialogFooter>
					<Button onClick={dismiss}>Got it</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
