export function findAdjacentKeyframeTimes<TTime extends number>({
	keyframeTimes,
	currentTime,
}: {
	keyframeTimes: TTime[];
	currentTime: TTime;
}): { previous: TTime | null; next: TTime | null } {
	const orderedTimes = [...new Set(keyframeTimes)].sort((a, b) => a - b);
	return {
		previous: orderedTimes.reduce<TTime | null>(
			(previous, time) => (time < currentTime ? time : previous),
			null,
		),
		next: orderedTimes.find((time) => time > currentTime) ?? null,
	};
}
