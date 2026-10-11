self.onmessage = async (
	event: MessageEvent<{
		id: number;
		channels: Float32Array[];
		sampleRate: number;
		amount: number;
		dynamics?: {
			ceilingDb: number;
			lookAheadMs: number;
			releaseMs: number;
			gain: number;
			gains?: Array<{ localTime: number; gain: number }>;
			start: number;
		};
	}>,
) => {
	const { id, channels, sampleRate, amount, dynamics } = event.data;
	try {
		const { reduceAudioNoise, hardLimitAudio } = await import("opencut-wasm");
		let result = channels.map((channel) =>
			reduceAudioNoise(channel, sampleRate, amount),
		);

		if (dynamics && result.length > 0) {
			const count = result.length;
			const pcm = new Float32Array(result[0].length * count);
			let point = 0;
			for (let i = 0; i < result[0].length; i++) {
				const time = dynamics.start + i / sampleRate;
				const points = dynamics.gains;
				let gain = dynamics.gain;
				if (points?.length) {
					while (
						point + 1 < points.length - 1 &&
						points[point + 1].localTime <= time
					)
						point++;
					const a = points[point],
						b = points[Math.min(point + 1, points.length - 1)];
					const fraction =
						b.localTime > a.localTime
							? Math.max(
									0,
									Math.min(
										1,
										(time - a.localTime) / (b.localTime - a.localTime),
									),
								)
							: 0;
					gain = a.gain + (b.gain - a.gain) * fraction;
				}
				for (let c = 0; c < count; c++)
					pcm[i * count + c] = result[c][i] * gain;
			}
			const wet = hardLimitAudio(
				pcm,
				count,
				sampleRate,
				dynamics.ceilingDb,
				dynamics.lookAheadMs,
				dynamics.releaseMs,
			);
			result = result.map((channel, c) =>
				Float32Array.from(
					{ length: channel.length },
					(_, i) => wet[i * count + c],
				),
			);
		}
		self.postMessage(
			{ id, channels: result },
			{ transfer: result.map((channel) => channel.buffer) },
		);
	} catch (error) {
		self.postMessage({
			id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};
