"use client";

import { LocalizedValue as UiValue } from "@/i18n/message";
import {
	LocalizedElement as UiLocalized,
	Message as UiMessage,
} from "@/i18n/message";
import { ElectronBackButton } from "@/components/electron-back-button";
import Image from "next/image";
import Link from "next/link";
import {
	ArrowDown,
	ArrowRight,
	AudioLines,
	Check,
	Film,
	KeyRound,
	Play,
	Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { LocalSignIn } from "@/accounts/local-sign-in";
import { LegalLinks } from "@/legal/links";
import { cn } from "@/utils/ui";
import { PocutWordmark } from "./pocut-brand";
import brand from "./pocut-brand.module.css";
import styles from "./landing.module.css";

const tools = [
	{
		icon: Sparkles,
		title: "AI direction",
		description: "Turn a brief into a storyboard.",
	},
	{
		icon: Film,
		title: "Precision editing",
		description: "Cut, layer and refine on the timeline.",
	},
	{
		icon: AudioLines,
		title: "Audio tools",
		description: "Separate dialogue and shape the mix.",
	},
];

function EditPreview() {
	return (
		<UiLocalized<"figure">
			element={"figure"}
			messageProps={["aria-label"]}
			className={styles.preview}
			aria-label="Illustration of the POCUT editor"
		>
			<div className={styles.previewBar}>
				<span className={styles.lights} aria-hidden="true">
					<i />
					<i />
					<i />
				</span>
				<span>
					<UiMessage text={"First Light"} />{" "}
					<span className={styles.dim}>/</span> <UiMessage text={"Edit 01"} />
				</span>
				<span className={styles.live}>
					<UiMessage text={"PREVIEW"} />
				</span>
			</div>
			<div className={styles.monitor}>
				<UiLocalized<typeof Image>
					element={Image}
					messageProps={["alt"]}
					src="/pocut/first-light.webp"
					alt="A lone explorer faces a mountain under violet clouds"
					fill
					priority
					sizes="(max-width: 860px) 94vw, 52vw"
				/>
				<span className={styles.frameLabel}>
					POCUT{" "}
					<span>
						<UiMessage text={"ORIGINAL FRAME"} />
					</span>
				</span>
				<span className={styles.aiTag}>
					<Sparkles size={13} /> <UiMessage text={"AI Director"} />
				</span>
			</div>
			<div className={styles.timeline} aria-hidden="true">
				<div className={styles.timecode}>
					<Play size={11} fill="currentColor" /> 00:00:04:12{" "}
					<span>00:00:08:00</span>
				</div>
				<div className={styles.tracks}>
					<div>
						<span>V2</span>
						<i />
						<i />
						<i />
					</div>
					<div>
						<span>V1</span>
						<i />
						<i />
						<i />
					</div>
					<div>
						<span>A1</span>
						<i />
						<i />
					</div>
					<b />
				</div>
			</div>
		</UiLocalized>
	);
}

export function PocutLanding({
	signedIn = false,
	legitateConfigured,
	legitateOnly,
	localReturnTo,
	error,
}: {
	signedIn?: boolean;
	legitateConfigured: boolean;
	legitateOnly: boolean;
	localReturnTo?: string;
	error?: string;
}) {
	const showLegitate = !signedIn && legitateConfigured;
	const workspaceHref = signedIn ? "/projects" : "#sign-in";
	return (
		<div className={cn(brand.theme, styles.page)}>
			<header className={styles.header}>
				<PocutWordmark />
				<UiLocalized<"nav">
					element={"nav"}
					messageProps={["aria-label"]}
					aria-label="Main navigation"
				>
					<ElectronBackButton />
					<a href="#pricing">
						<UiMessage text={"Pricing"} />
					</a>
					<a className={styles.navAction} href={workspaceHref}>
						{signedIn ? (
							<UiMessage text={"Projects"} />
						) : (
							<UiMessage text={"Sign in"} />
						)}{" "}
						<ArrowRight size={15} />
					</a>
				</UiLocalized>
			</header>
			<main className={styles.content}>
				<section className={styles.hero} aria-labelledby="welcome">
					<div className={styles.intro}>
						<div className={cn(brand.eyebrow, styles.kicker)}>
							<Sparkles size={14} /> <UiMessage text={"Welcome to POCUT"} />
						</div>
						<h1 id="welcome">
							<UiMessage text={"Make the cut."} />
							<br />
							<em>
								<UiMessage text={"Direct with AI."} />
							</em>
						</h1>
						<p>
							<UiMessage
								text={
									"Go from idea to finished video in one workspace. Storyboard with AI, shape the edit on a precise timeline, and bring the AI services you already use."
								}
							/>
						</p>
						<div id="sign-in" className={styles.actions} tabIndex={-1}>
							{signedIn && (
								<Button
									asChild
									size="lg"
									className={cn(brand.primary, styles.actionButton)}
								>
									<Link href="/projects">
										<UiMessage text={"Open your workspace"} /> <ArrowRight />
									</Link>
								</Button>
							)}
							{showLegitate && (
								<form action="/api/accounts/legitate/start" method="post">
									<Button
										type="submit"
										size="lg"
										className={cn(brand.primary, styles.actionButton)}
									>
										<KeyRound /> <UiMessage text={"Sign in with Legitate"} />{" "}
										<ArrowRight />
									</Button>
								</form>
							)}
							<a href="#pricing" className={styles.priceLink}>
								<UiMessage text={"See pricing"} /> <ArrowDown size={14} />
							</a>
						</div>
						{showLegitate && legitateOnly && (
							<p className="text-sm text-muted-foreground">
								<UiMessage text={"On the Legitate consent screen, select account identification to continue."} />
							</p>
						)}
						{error && (
							<p className={styles.error} role="alert">
								<UiValue>{error}</UiValue>
							</p>
						)}
						{!signedIn &&
							!legitateOnly &&
							(showLegitate ? (
								<details className={styles.localAccess}>
									<summary>
										<UiMessage text={"Use a local account"} />
									</summary>
									<LocalSignIn returnTo={localReturnTo} />
								</details>
							) : (
								<LocalSignIn returnTo={localReturnTo} />
							))}
						{!signedIn && legitateOnly && !legitateConfigured && !error && (
							<p className={styles.error} role="status">
								<UiMessage
									text={"Legitate sign-in is unavailable on this installation."}
								/>
							</p>
						)}
					</div>
					<EditPreview />
				</section>
				<UiLocalized<"section">
					element={"section"}
					messageProps={["aria-label"]}
					aria-label="Editing features"
					className={styles.featureStrip}
				>
					{tools.map(({ icon: Icon, title, description }) => (
						<div key={title}>
							<Icon size={20} />
							<div>
								<h2>{title}</h2>
								<p>{description}</p>
							</div>
						</div>
					))}
				</UiLocalized>
				<section
					id="pricing"
					className={styles.pricing}
					aria-labelledby="pricing-title"
				>
					<div className={styles.priceIntro}>
						<span className={cn(brand.eyebrow, styles.kicker)}>
							<UiMessage text={"Pricing"} />
						</span>
						<h2 id="pricing-title">
							<UiMessage text={"A plan for your next cut."} />
						</h2>
						<p>
							<UiMessage
								text={
									"Start free or choose the $5 plan. For external AI services, bring your own API key or connect a supported membership you already have."
								}
							/>
						</p>
					</div>
					<div className={styles.plans}>
						<article className={styles.plan}>
							<h3>
								<UiMessage text={"Free"} />
							</h3>
							<strong>$0</strong>
							<p>
								<UiMessage text={"Start creating with POCUT."} />
							</p>
							<a href={workspaceHref}>
								<Check size={16} /> <UiMessage text={"Get started"} />
							</a>
						</article>
						<article className={cn(styles.plan, styles.paid)}>
							<h3>
								<UiMessage text={"POCUT Pro"} />
							</h3>
							<strong>
								$5{" "}
								<small>
									<UiMessage text={"USD"} />
								</small>
							</strong>
							<p>
								<UiMessage text={"The paid POCUT plan."} />
							</p>
							<a href={workspaceHref}>
								<ArrowRight size={16} />{" "}
								<UiMessage text={"Open your workspace"} />
							</a>
						</article>
					</div>
					<p className={styles.aiNotice}>
						<KeyRound size={17} />{" "}
						<UiMessage
							text={
								"External AI usage is billed separately by your provider according to your key or membership."
							}
						/>
					</p>
				</section>
			</main>
			<footer className={styles.footer}>
				<PocutWordmark />
				<span>
					<UiMessage text={"AI video editing workspace"} />
				</span>
				<UiLocalized<"nav">
					element={"nav"}
					messageProps={["aria-label"]}
					aria-label="Footer navigation"
				>
					<a href="#pricing">
						<UiMessage text={"Pricing"} />
					</a>
					<a href={workspaceHref}>
						{signedIn ? (
							<UiMessage text={"Projects"} />
						) : (
							<UiMessage text={"Sign in"} />
						)}
					</a>
					<LegalLinks />
				</UiLocalized>
			</footer>
		</div>
	);
}
