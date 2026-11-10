import { fileUrl } from "@/generative/client";
import styles from "./overlay.module.css";

const animatedHandoffs = new Set<string>();

/** Decorative transport animation only; called after a canonical handoff commits. */
export function animateDirectorHandoff({
	projectId,
	referenceIds,
	handoffId,
}: {
	projectId: string;
	referenceIds: string[];
	handoffId?: string;
}) {
	const key = handoffId
		? `${window.__opencutAccountId}:${projectId}:${handoffId}`
		: undefined;
	if (key && animatedHandoffs.has(key)) return;
	if (key) {
		animatedHandoffs.add(key);
		if (animatedHandoffs.size > 64)
			animatedHandoffs.delete(animatedHandoffs.values().next().value!);
	}
	const source = document.querySelector('[data-production-board="true"]');
	const target = document.querySelector('[data-assets-tab="generative"]');
	if (
		!source ||
		!target ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	)
		return;
	const from = source.getBoundingClientRect(),
		to = target.getBoundingClientRect();
	if (!from.width || !from.height || !to.width || !to.height) return;
	const startX = Math.min(
		window.innerWidth - 72,
		Math.max(8, from.left + from.width / 2 - 32),
	);
	const startY = Math.min(window.innerHeight - 80, Math.max(8, from.top + 36));
	const items: (string | null)[] = [null, ...referenceIds.slice(0, 4)];
	items.forEach((referenceId, index) => {
		const card = document.createElement("div");
		card.className = styles.handoffCard;
		card.setAttribute("aria-hidden", "true");
		card.style.left = `${startX}px`;
		card.style.top = `${startY}px`;
		if (referenceId) {
			const img = document.createElement("img");
			img.src = fileUrl({ projectId, id: referenceId });
			img.alt = "";
			card.append(img);
		} else {
			card.textContent = "≡";
		}
		document.body.append(card);
		const animation = card.animate(
			[
				{
					transform: `translate(${index * 7}px, ${index * 6}px) rotate(${index * 4 - 8}deg) scale(.8)`,
					opacity: 0,
				},
				{
					transform: `translate(${index * 5}px, -24px) rotate(0) scale(1)`,
					opacity: 1,
					offset: 0.25,
				},
				{
					transform: `translate(${to.left + to.width / 2 - startX - 32}px, ${to.top + to.height / 2 - startY - 32}px) rotate(-8deg) scale(.15)`,
					opacity: 0,
				},
			],
			{
				duration: 1000,
				delay: index * 100,
				easing: "cubic-bezier(.22,.65,.25,1)",
				fill: "both",
			},
		);
		animation.finished.then(
			() => card.remove(),
			() => card.remove(),
		);
	});
}
