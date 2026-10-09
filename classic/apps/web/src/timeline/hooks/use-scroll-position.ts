import { useEffect, useState, useRef } from "react";

export interface ScrollPosition {
	scrollLeft: number;
	scrollTop: number;
	viewportWidth: number;
	viewportHeight: number;
}

const INITIAL_SCROLL_POSITION: ScrollPosition = {
	scrollLeft: 0,
	scrollTop: 0,
	viewportWidth: 0,
	viewportHeight: 0,
};

type ScrollPositionElement = Pick<
	HTMLElement,
	"scrollLeft" | "scrollTop" | "clientWidth" | "clientHeight"
>;

export function readScrollPosition({
	scrollElement,
}: {
	scrollElement: ScrollPositionElement;
}): ScrollPosition {
	return {
		scrollLeft: scrollElement.scrollLeft,
		scrollTop: scrollElement.scrollTop,
		viewportWidth: scrollElement.clientWidth,
		viewportHeight: scrollElement.clientHeight,
	};
}

export function areScrollPositionsEqual({
	a,
	b,
}: {
	a: ScrollPosition;
	b: ScrollPosition;
}): boolean {
	return (
		a.scrollLeft === b.scrollLeft &&
		a.scrollTop === b.scrollTop &&
		a.viewportWidth === b.viewportWidth &&
		a.viewportHeight === b.viewportHeight
	);
}

export function useScrollPosition({
	scrollRef,
}: {
	scrollRef: React.RefObject<HTMLElement | null>;
}): ScrollPosition {
	const [position, setPosition] = useState(INITIAL_SCROLL_POSITION);
	const positionRef = useRef(position);

	useEffect(() => {
		const scrollElement = scrollRef.current;
		if (!scrollElement) return;
		return observeScrollPosition({
			scrollElement,
			onChange: (nextPosition) => {
				if (
					areScrollPositionsEqual({
						a: positionRef.current,
						b: nextPosition,
					})
				) {
					return;
				}

				positionRef.current = nextPosition;
				setPosition(nextPosition);
			},
		});
	}, [scrollRef]);

	return position;
}

/** Each effect setup owns its scheduled frame, including Strict Mode restarts. */
export function observeScrollPosition({
	scrollElement,
	onChange,
}: {
	scrollElement: HTMLElement;
	onChange: (position: ScrollPosition) => void;
}): () => void {
	let frameId: number | null = null;
	const updatePosition = () => {
		if (frameId !== null) return;
		frameId = requestAnimationFrame(() => {
			frameId = null;
			onChange(readScrollPosition({ scrollElement }));
		});
	};
	const resizeObserver = new ResizeObserver(updatePosition);
	updatePosition();
	scrollElement.addEventListener("scroll", updatePosition, { passive: true });
	resizeObserver.observe(scrollElement);

	return () => {
		scrollElement.removeEventListener("scroll", updatePosition);
		resizeObserver.disconnect();
		if (frameId !== null) {
			cancelAnimationFrame(frameId);
			frameId = null;
		}
	};
}
