"use client";

import {
	Message as UiMessage,
	LocalizedElement as UiLocalized,
} from "@/i18n/message";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

export function DeleteProjectDialog({
	isOpen,
	onOpenChange,
	onConfirm,
	projectNames,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void | Promise<void>;
	projectNames: string[];
}) {
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			{isOpen ? (
				<DeleteProjectDialogContent
					key={projectNames.join("\0")}
					onOpenChange={onOpenChange}
					onConfirm={onConfirm}
					projectNames={projectNames}
				/>
			) : null}
		</Dialog>
	);
}

function DeleteProjectDialogContent({
	onOpenChange,
	onConfirm,
	projectNames,
}: {
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void | Promise<void>;
	projectNames: string[];
}) {
	const count = projectNames.length;
	const isSingle = count === 1;
	const singleName = isSingle ? projectNames[0] : null;
	const [confirmation, setConfirmation] = useState("");
	const [isConfirming, setIsConfirming] = useState(false);
	const isConfirmed = confirmation === "DELETE";

	const handleConfirm = async () => {
		if (!isConfirmed || isConfirming) return;
		setIsConfirming(true);
		setConfirmation("");
		try {
			await onConfirm();
		} finally {
			setIsConfirming(false);
		}
	};

	return (
		<DialogContent
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				event.stopPropagation();
			}}
		>
			<DialogHeader>
				<DialogTitle>
					{singleName ? (
						<>
							{<UiMessage text={"Delete '"} />}
							<span className="inline-block max-w-[300px] truncate align-bottom">
								{singleName}
							</span>
							{"'?"}
						</>
					) : (
						<UiMessage
							text={"Delete {v0} projects?"}
							values={{ v0: String(count) }}
						/>
					)}
				</DialogTitle>
			</DialogHeader>
			<DialogBody>
				<Alert variant="destructive">
					<AlertTitle>
						<UiMessage text={"Warning"} />
					</AlertTitle>
					<AlertDescription>
						<UiMessage text={"This will permanently delete"} />{" "}
						{singleName ? (
							`"${singleName}"`
						) : (
							<UiMessage
								text={"{v0} projects"}
								values={{ v0: String(count) }}
							/>
						)}{" "}
						<UiMessage text={"and all associated files."} />
					</AlertDescription>
				</Alert>
				<div className="flex flex-col gap-3">
					<Label
						htmlFor="delete-project-confirmation"
						className="text-xs font-semibold text-slate-500"
					>
						{<UiMessage text={'Type "DELETE" to confirm'} />}
					</Label>
					<UiLocalized<typeof Input>
						element={Input}
						messageProps={["placeholder"]}
						id="delete-project-confirmation"
						type="text"
						placeholder="DELETE"
						value={confirmation}
						onChange={(event) => setConfirmation(event.target.value)}
						autoComplete="off"
						spellCheck={false}
						size="lg"
						variant="destructive"
					/>
				</div>
			</DialogBody>
			<DialogFooter>
				<Button variant="outline" onClick={() => onOpenChange(false)}>
					<UiMessage text={"Cancel"} />
				</Button>
				<Button
					variant="destructive"
					onClick={() => void handleConfirm()}
					disabled={!isConfirmed || isConfirming}
				>
					{isConfirming ? (
						<UiMessage text={"Deleting…"} />
					) : isSingle ? (
						<UiMessage text={"Delete project"} />
					) : (
						<UiMessage text={"Delete projects"} />
					)}
				</Button>
			</DialogFooter>
		</DialogContent>
	);
}
