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
	const rafIdRef = useRef<number | null>(null);

	useEffect(() => {
		const scrollElement = scrollRef.current;
		if (!scrollElement) return;

		const updatePosition = () => {
			if (rafIdRef.current !== null) return;

			rafIdRef.current = requestAnimationFrame(() => {
				rafIdRef.current = null;
				const nextPosition = readScrollPosition({ scrollElement });
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
			});
		};

		const resizeObserver = new ResizeObserver(() => {
			updatePosition();
		});

		updatePosition();

		scrollElement.addEventListener("scroll", updatePosition, { passive: true });
		resizeObserver.observe(scrollElement);

		return () => {
			scrollElement.removeEventListener("scroll", updatePosition);
			resizeObserver.disconnect();
			if (rafIdRef.current !== null) {
				cancelAnimationFrame(rafIdRef.current);
			}
		};
	}, [scrollRef]);

	return position;
}
