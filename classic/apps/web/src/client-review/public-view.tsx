"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
	LockKeyhole,
	MessageSquare,
	Sparkles,
	Send,
	Check,
	Play,
	Pause,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	reviewRequest,
	jsonRequest,
	reviewTime,
	type PublicReview,
} from "./client";
export function PublicReviewView({ token }: { token: string }) {
	return <PublicReviewSession key={token} token={token} />;
}

function PublicReviewSession({ token }: { token: string }) {
	const endpoint = `/api/client-review/${token}`;
	const [review, setReview] = useState<PublicReview | null>(null),
		[locked, setLocked] = useState(false),
		[password, setPassword] = useState(""),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false),
		[time, setTime] = useState(0),
		[playing, setPlaying] = useState(false),
		[body, setBody] = useState(""),
		[authorName, setAuthorName] = useState(""),
		[success, setSuccess] = useState(false);
	const video = useRef<HTMLVideoElement>(null),
		comment = useRef<HTMLTextAreaElement>(null),
		nonce = useRef<{
			fingerprint: string;
			value: string;
		} | null>(null),
		requestVersion = useRef(0),
		operation = useRef<AbortController | null>(null),
		alive = useRef(true);
	useEffect(() => {
		let cancelled = false;
		alive.current = true;
		requestVersion.current++;
		nonce.current = null;
		const load = async () => {
			if (operation.current) return;
			const version = ++requestVersion.current;
			try {
				const response = await fetch(endpoint, { cache: "no-store" });
				const data = await response.json();
				if (cancelled || version !== requestVersion.current) return;
				if (data.locked) {
					setLocked(true);
					setReview(null);
					return;
				}
				if (!response.ok) {
					if (response.status === 404 || response.status === 410) {
						video.current?.pause();
						setReview(null);
						setLocked(false);
					}
					throw new Error(data.error || "This preview is unavailable");
				}
				setLocked(false);
				setReview(data);
			} catch (e) {
				if (!cancelled && version === requestVersion.current)
					setError(e instanceof Error ? e.message : "Could not load review");
			}
		};
		void load();
		const timer = setInterval(() => {
			if (!document.hidden) void load();
		}, 15000);
		return () => {
			cancelled = true;
			alive.current = false;
			operation.current?.abort();
			clearInterval(timer);
		};
	}, [endpoint]);
	const seek = (ticks: number) => {
		if (video.current) video.current.currentTime = ticks / 120000;
		setTime(ticks);
		setSuccess(false);
	};
	const unlock = async () => {
		if (operation.current) return;
		const controller = new AbortController();
		operation.current = controller;
		const version = ++requestVersion.current;
		setBusy(true);
		setError("");
		try {
			const data = await reviewRequest<PublicReview>({
				path: endpoint,
				init: {
					...jsonRequest({
						method: "POST",
						data: { action: "unlock", password },
					}),
					signal: controller.signal,
				},
			});
			if (!alive.current || version !== requestVersion.current) return;
			setPassword("");
			setReview(data);
			setLocked(false);
		} catch (e) {
			if (alive.current && version === requestVersion.current)
				setError(e instanceof Error ? e.message : "Could not unlock review");
		} finally {
			if (operation.current === controller) operation.current = null;
			if (alive.current) setBusy(false);
		}
	};
	const submit = async () => {
		if (operation.current || !review) return;
		const controller = new AbortController();
		operation.current = controller;
		const version = ++requestVersion.current;
		setBusy(true);
		setError("");
		video.current?.pause();
		const timeTicks = Math.min(review.share.durationTicks, Math.round(time));
		const fingerprint = JSON.stringify([
			body.trim(),
			authorName.trim(),
			timeTicks,
		]);
		if (nonce.current?.fingerprint !== fingerprint)
			nonce.current = { fingerprint, value: crypto.randomUUID() };
		try {
			const data = await reviewRequest<PublicReview>({
				path: endpoint,
				init: {
					...jsonRequest({
						method: "POST",
						data: {
							action: "comment",
							nonce: nonce.current.value,
							body,
							authorName,
							timeTicks,
						},
					}),
					signal: controller.signal,
				},
			});
			if (!alive.current || version !== requestVersion.current) return;
			setReview(data);
			setBody("");
			nonce.current = null;
			setSuccess(true);
		} catch (e) {
			if (alive.current && version === requestVersion.current)
				setError(e instanceof Error ? e.message : "Could not save comment");
		} finally {
			if (operation.current === controller) operation.current = null;
			if (alive.current) setBusy(false);
		}
	};
	const field =
		"w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white outline-none focus:border-violet-400 focus:ring-1 focus:ring-violet-400";
	return (
		<main className="min-h-screen bg-[#0c0d12] text-[#f0eff7]" dir="ltr">
			<header className="border-b border-white/10 px-5 py-5 sm:px-10">
				<div className="mx-auto flex max-w-7xl items-center justify-between gap-5">
					<Link href="/" className="text-lg font-black tracking-[.22em]">
						POCUT
						<span className="ml-3 text-xs font-normal tracking-normal text-white/40">
							CLIENT PREVIEW
						</span>
					</Link>
					<span className="flex items-center gap-2 text-xs text-white/50">
						<LockKeyhole size={13} />
						Feedback workspace
					</span>
				</div>
			</header>
			{!review || locked ? (
				<section className="mx-auto my-24 max-w-md px-6">
					<div className="rounded-3xl border border-white/10 bg-white/[.03] p-8">
						<LockKeyhole className="mb-5 text-violet-300" size={32} />
						<h1 className="text-2xl font-semibold">
							{locked ? "Your preview is protected" : "Your video preview"}
						</h1>
						<p className="mt-3 text-sm leading-6 text-white/55">
							{locked
								? "Enter the password shared by your editor to watch this version and leave feedback."
								: error || "Opening your review workspace…"}
						</p>
						{locked && (
							<form
								className="mt-6 space-y-4"
								onSubmit={(e) => {
									e.preventDefault();
									void unlock();
								}}
							>
								<label className="block text-sm" htmlFor="review-password">
									Review password
								</label>
								<input
									id="review-password"
									autoComplete="current-password"
									type="password"
									className={field}
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									maxLength={128}
									required
								/>
								<Button className="w-full" type="submit" disabled={busy}>
									{busy ? "Unlocking…" : "Open preview"}
								</Button>
							</form>
						)}
						{locked && error && (
							<p role="alert" className="mt-4 text-sm text-rose-300">
								{error}
							</p>
						)}
					</div>
				</section>
			) : (
				<div className="mx-auto max-w-7xl px-5 py-8 sm:px-10">
					<div className="mb-7 flex flex-wrap items-end justify-between gap-3">
						<div>
							<p className="mb-2 text-xs uppercase tracking-[.18em] text-violet-300">
								A clear view. Better feedback.
							</p>
							<h1 className="text-3xl font-semibold tracking-tight" dir="auto">
								{review.share.title || "Video preview"}
							</h1>
						</div>
						<span className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/50">
							Version {review.share.version.slice(0, 8)} ·{" "}
							{new Date(review.share.createdAt).toLocaleDateString()}
						</span>
					</div>
					<div className="grid gap-7 lg:grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]">
						<section
							aria-label="Preview video and timeline"
							className="min-w-0"
						>
							<div className="overflow-hidden rounded-2xl border border-white/10 bg-black">
								{/* eslint-disable-next-line jsx-a11y/media-has-caption -- This rendered project preview preserves any captions in the video; no separate caption track exists. */}
								<video
									ref={video}
									src={`${endpoint}/media`}
									playsInline
									preload="metadata"
									className="aspect-video w-full"
									onTimeUpdate={(e) =>
										setTime(Math.round(e.currentTarget.currentTime * 120000))
									}
									onPlay={() => setPlaying(true)}
									onPause={() => setPlaying(false)}
									onError={() =>
										setError(
											"The video could not load. Refresh the page or ask the editor for a new link.",
										)
									}
									controls
								/>
								<div className="border-t border-white/10 bg-[#15161e] p-5">
									<div className="mb-4 flex items-center justify-between text-xs text-white/50">
										<span className="flex items-center gap-2">
											<MessageSquare size={14} />
											Click the timeline to place feedback
										</span>
										<span className="font-mono">
											{reviewTime(time)} /{" "}
											{reviewTime(review.share.durationTicks)}
										</span>
									</div>
									<div className="relative pb-6">
										<input
											aria-label="Review timeline"
											type="range"
											className="h-2 w-full cursor-pointer accent-violet-400"
											min={0}
											max={review.share.durationTicks}
											step={1200}
											value={Math.min(time, review.share.durationTicks)}
											onChange={(e) => {
												video.current?.pause();
												seek(Number(e.target.value));
											}}
										/>
										{review.comments.map((c) => (
											<button
												key={c.id}
												aria-label={`Comment at ${reviewTime(c.timeTicks)} by ${c.authorName}`}
												title={`${reviewTime(c.timeTicks)} · ${c.body}`}
												className={`absolute top-7 size-2.5 -translate-x-1/2 rounded-full ring-2 ring-[#15161e] ${c.resolved ? "bg-emerald-400" : "bg-violet-400"}`}
												style={{
													left: `${(c.timeTicks / review.share.durationTicks) * 100}%`,
												}}
												onClick={() => {
													video.current?.pause();
													seek(c.timeTicks);
													document
														.getElementById(`review-comment-${c.id}`)
														?.scrollIntoView({
															block: "nearest",
															behavior: "smooth",
														});
												}}
											/>
										))}
									</div>
									<div className="mt-3 flex flex-wrap items-center gap-3">
										<Button
											variant="outline"
											className="border-white/15 bg-white/5 text-white"
											onClick={() => {
												if (playing) video.current?.pause();
												else void video.current?.play().catch(() => {});
											}}
										>
											{playing ? <Pause /> : <Play />}
											{playing ? "Pause" : "Play"}
										</Button>
										<Button
											className="bg-violet-300 text-[#171222] hover:bg-violet-200"
											onClick={() => {
												video.current?.pause();
												comment.current?.focus();
											}}
										>
											Add feedback at {reviewTime(time)}
										</Button>
									</div>
								</div>
							</div>
							<div className="mt-5 rounded-2xl border border-violet-300/15 bg-violet-300/[.04] p-6">
								<div className="flex items-center gap-3">
									<Sparkles className="text-violet-300" size={20} />
									<h2 className="font-medium">
										Your creative feedback assistant
									</h2>
									<span className="ml-auto rounded-full bg-violet-300/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-violet-200">
										Coming Soon
									</span>
								</div>
								<p className="mt-3 text-sm leading-6 text-white/50">
									Describe what you would like to change in your own words: a
									different opening, a shorter scene, a music change, or the
									timing of a title. The assistant will help locate the moment,
									ask for clarification when needed, and turn your feedback into
									clear comments on this timeline for your editor to review.
								</p>
								<p className="mt-3 text-xs text-violet-200/70">
									Planned feature · AI chat is not available yet. Use
									timestamped comments for this review.
								</p>
							</div>
						</section>
						<aside className="min-w-0 rounded-2xl border border-white/10 bg-white/[.025] p-5">
							<div className="mb-5 flex items-center justify-between">
								<h2 className="font-medium">Feedback</h2>
								<span className="text-xs text-white/40">
									{review.comments.filter((c) => !c.resolved).length} open
								</span>
							</div>
							<form
								className="space-y-3 border-b border-white/10 pb-6"
								onSubmit={(e) => {
									e.preventDefault();
									void submit();
								}}
							>
								<label
									className="block text-xs text-white/55"
									htmlFor="review-author"
								>
									Your name · visible to everyone with this link
								</label>
								<input
									id="review-author"
									disabled={busy}
									className={field}
									value={authorName}
									onChange={(e) => setAuthorName(e.target.value)}
									maxLength={80}
									required
									autoComplete="name"
									placeholder="How should we call you?"
								/>
								<label
									className="block text-xs text-white/55"
									htmlFor="review-feedback"
								>
									Your feedback at{" "}
									<span className="font-mono text-violet-300">
										{reviewTime(time)}
									</span>
								</label>
								<textarea
									id="review-feedback"
									disabled={busy}
									ref={comment}
									dir="auto"
									className={`${field} min-h-28 resize-y`}
									value={body}
									onChange={(e) => {
										setBody(e.target.value);
										setSuccess(false);
										nonce.current = null;
									}}
									maxLength={2000}
									required
									placeholder="Tell us what you would change at this moment…"
								/>
								<Button
									type="submit"
									className="w-full bg-violet-300 text-[#171222] hover:bg-violet-200"
									disabled={busy || !body.trim() || !authorName.trim()}
								>
									<Send />
									{busy ? "Saving…" : "Send feedback"}
								</Button>
								{success && (
									<p
										role="status"
										className="flex items-center gap-2 text-xs text-emerald-300"
									>
										<Check size={14} />
										Your feedback is saved for the editor.
									</p>
								)}
								{error && (
									<p role="alert" className="text-sm text-rose-300">
										{error}
									</p>
								)}
							</form>
							<div className="max-h-[650px] space-y-3 overflow-auto pt-5">
								{!review.comments.length && (
									<p className="py-8 text-center text-sm leading-6 text-white/35">
										Your feedback starts here.
										<br />
										Choose a moment in the video to leave the first note.
									</p>
								)}
								{[...review.comments]
									.sort((a, b) => a.timeTicks - b.timeTicks)
									.map((c) => (
										<article
											key={c.id}
											id={`review-comment-${c.id}`}
											className={`rounded-xl border p-4 ${c.resolved ? "border-emerald-300/15 bg-emerald-300/[.03]" : "border-white/10 bg-white/[.025]"}`}
										>
											<div className="mb-3 flex items-center gap-2">
												<button
													onClick={() => {
														video.current?.pause();
														seek(c.timeTicks);
													}}
													className="rounded bg-violet-300/10 px-2 py-1 font-mono text-xs text-violet-200"
												>
													{reviewTime(c.timeTicks)}
												</button>
												<span
													className="min-w-0 truncate text-xs text-white/50"
													dir="auto"
												>
													{c.authorName}
												</span>
												{c.resolved && (
													<span className="ml-auto text-[10px] text-emerald-300">
														Resolved
													</span>
												)}
											</div>
											<p
												className="whitespace-pre-wrap break-words text-sm leading-6 text-white/80"
												dir="auto"
											>
												{c.body}
											</p>
										</article>
									))}
							</div>
						</aside>
					</div>
					<p className="mt-7 text-center text-xs text-white/30">
						Reviewing a fixed video version · Names are supplied by reviewers ·
						Link expires {new Date(review.expiresAt).toLocaleDateString()}
					</p>
				</div>
			)}
		</main>
	);
}
