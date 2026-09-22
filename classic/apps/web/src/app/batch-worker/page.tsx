"use client";
import { useEffect } from "react";
import { executeBatch } from "@/batch/worker";
let started = false;
export default function BatchWorker() {
	useEffect(() => {
		const ready = () => {
			if (!started)
				parent.postMessage({ type: "opencut-batch-ready" }, location.origin);
		};
		const handshake = setInterval(ready, 1000);
		const handle = (event: MessageEvent) => {
			if (
				event.origin !== location.origin ||
				event.source !== parent ||
				event.data?.type !== "opencut-batch-start" ||
				started
			)
				return;
			started = true;
			clearInterval(handshake);
			void executeBatch(event.data);
		};
		window.addEventListener("message", handle);
		ready();
		return () => {
			clearInterval(handshake);
			window.removeEventListener("message", handle);
		};
	}, []);
	return <p>Full Auto Edit batch worker</p>;
}
