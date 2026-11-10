"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Message } from "@/i18n/message";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogBody,
	DialogFooter,
} from "@/components/ui/dialog";

interface Review {
	accountId: string;
	projectId: string;
	prompt: string;
	referenceCount: number;
	resolve: (accepted: boolean) => void;
}
const listeners = new Set<(review: Review | null) => void>();
let pending: Review | null = null;
/** Ephemeral human approval only; the canonical capability owns the request and output. */
export function reviewNativeImage({
	accountId,
	projectId,
	prompt,
	referenceCount,
	signal,
}: {
	accountId: string;
	projectId: string;
	prompt: string;
	referenceCount: number;
	signal: AbortSignal;
}): Promise<boolean> {
	signal.throwIfAborted();
	if (pending)
		throw new Error("Finish the current image review before starting another");
	if (!listeners.size)
		throw new Error("Open the docked Agent to review image generation");
	return new Promise((resolve) => {
		const finish = (accepted: boolean) => {
			if (pending !== review) return;
			pending = null;
			signal.removeEventListener("abort", abort);
			for (const listener of listeners) listener(null);
			resolve(
				accepted && window.__opencutAccountId === accountId && !signal.aborted,
			);
		};
		const review: Review = {
			accountId,
			projectId,
			prompt,
			referenceCount,
			resolve: finish,
		};
		const abort = () => finish(false);
		pending = review;
		signal.addEventListener("abort", abort, { once: true });
		for (const listener of listeners) listener(review);
	});
}
export function ImageGenerationReviewHost({
	accountId,
	projectId,
}: {
	accountId: string;
	projectId?: string;
}) {
	const [review, setReview] = useState<Review | null>(null);
	useEffect(() => {
		const listener = (next: Review | null) => setReview(next);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			pending?.resolve(false);
		};
	}, []);
	useEffect(() => {
		if (
			review &&
			(review.accountId !== accountId || review.projectId !== projectId)
		)
			review.resolve(false);
	}, [review, accountId, projectId]);
	const shown =
		review?.accountId === accountId && review?.projectId === projectId
			? review
			: null;
	return (
		<Dialog
			open={!!shown}
			onOpenChange={(open) => {
				if (!open) shown?.resolve(false);
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						<Message text="Review image generation" />
					</DialogTitle>
					<DialogDescription>
						<Message text="This uses your connected Codex subscription and its image limits. Confirm the exact prompt before generation." />
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm">
						{shown?.prompt}
					</p>
					<p className="text-xs">
						<Message text="Reference images" />: {shown?.referenceCount ?? 0}
					</p>
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={() => shown?.resolve(false)}>
						<Message text="Cancel" />
					</Button>
					<Button onClick={() => shown?.resolve(true)}>
						<Message text="Generate this image" />
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
