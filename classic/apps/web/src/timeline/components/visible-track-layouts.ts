export interface VisibleTrackLayout {
	index: number;
	top: number;
	height: number;
}

export function getVisibleTrackLayouts<TLayout extends VisibleTrackLayout>({
	layouts,
	scrollTop,
	viewportHeight,
	overscanPx,
	forcedIndexes,
}: {
	layouts: TLayout[];
	scrollTop: number;
	viewportHeight: number;
	overscanPx: number;
	forcedIndexes?: ReadonlySet<number>;
}): TLayout[] {
	if (viewportHeight <= 0 || layouts.length === 0) {
		return layouts;
	}

	const visibleTop = Math.max(0, scrollTop - overscanPx);
	const visibleBottom = scrollTop + viewportHeight + overscanPx;
	const startPosition = lowerBoundLayoutBottom({ layouts, top: visibleTop });
	const endPosition = upperBoundLayoutTop({ layouts, top: visibleBottom });
	const visiblePositions = new Set<number>();

	for (let position = startPosition; position < endPosition; position += 1) {
		visiblePositions.add(position);
	}

	if (forcedIndexes) {
		for (const forcedIndex of forcedIndexes) {
			const position = findLayoutPositionByIndex({ layouts, index: forcedIndex });
			if (position !== -1) {
				visiblePositions.add(position);
			}
		}
	}

	return [...visiblePositions]
		.sort((a, b) => a - b)
		.map((position) => layouts[position]);
}

function lowerBoundLayoutBottom<TLayout extends VisibleTrackLayout>({
	layouts,
	top,
}: {
	layouts: TLayout[];
	top: number;
}) {
	let low = 0;
	let high = layouts.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (layouts[mid].top + layouts[mid].height < top) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

function upperBoundLayoutTop<TLayout extends VisibleTrackLayout>({
	layouts,
	top,
}: {
	layouts: TLayout[];
	top: number;
}) {
	let low = 0;
	let high = layouts.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (layouts[mid].top <= top) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

function findLayoutPositionByIndex<TLayout extends VisibleTrackLayout>({
	layouts,
	index,
}: {
	layouts: TLayout[];
	index: number;
}) {
	let low = 0;
	let high = layouts.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (layouts[mid].index < index) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return layouts[low]?.index === index ? low : -1;
}
