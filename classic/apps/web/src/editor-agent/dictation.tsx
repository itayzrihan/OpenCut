"use client";

import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Message, LocalizedElement } from "@/i18n/message";
import { useInterfaceLanguage } from "@/i18n/provider";
import styles from "./overlay.module.css";

type Language = "he-IL" | "en-US";
type SpeechResult = {
	resultIndex: number;
	results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};
type Recognition = {
	lang: Language;
	continuous: boolean;
	interimResults: boolean;
	processLocally?: boolean;
	onresult: ((event: SpeechResult) => void) | null;
	onerror: ((event: { error: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
};
type RecognitionConstructor = {
	new (): Recognition;
	available?: (options: {
		langs: Language[];
		processLocally: true;
	}) => Promise<string>;
};

function speechRecognition() {
	const browser = window as Window & {
		SpeechRecognition?: RecognitionConstructor;
		webkitSpeechRecognition?: RecognitionConstructor;
	};
	return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}
const subscribe = () => () => {};
const supportedByBrowser = () => Boolean(speechRecognition());
const noServerSpeech = () => false;

export function dictationLanguage({
	draft,
	locale,
	browser,
}: {
	draft: string;
	locale: string;
	browser: string;
}): Language {
	const letter = draft.match(/[a-z\u05d0-\u05ea]/i)?.[0];
	if (letter) return /[\u05d0-\u05ea]/.test(letter) ? "he-IL" : "en-US";
	return [locale, browser].some((language) => /^he(?:-|$)/i.test(language))
		? "he-IL"
		: "en-US";
}

export function appendDictation({
	draft,
	transcript,
}: {
	draft: string;
	transcript: string;
}) {
	const text = transcript.trim();
	if (!text) return draft;
	const space =
		draft && !/\s$/.test(draft) && !/^[.,!?;:]/.test(text) ? " " : "";
	return (draft + space + text).slice(0, 100_000);
}

function dictationError(code: string) {
	switch (code) {
		case "aborted":
			return "";
		case "not-allowed":
		case "service-not-allowed":
			return "Allow microphone access in your browser to dictate.";
		case "audio-capture":
			return "No microphone is available for dictation.";
		case "no-speech":
			return "No speech detected. Try dictating again.";
		case "language-not-supported":
			return "This browser does not support dictation in the selected language.";
		default:
			return "Dictation could not start. Try again.";
	}
}

export function useBrowserDictation({
	onTranscript,
	enabled,
	scope,
}: {
	onTranscript: (transcript: string) => void;
	enabled: boolean;
	scope: string;
}) {
	const supported = useSyncExternalStore(
		subscribe,
		supportedByBrowser,
		noServerSpeech,
	);
	const onDevice = useRef(new Set<Language>());
	const current = useRef<{
		recognition: Recognition;
	} | null>(null);
	const [phase, setPhase] = useState<"idle" | "listening" | "stopping">("idle");
	const [error, setError] = useState("");
	useEffect(() => {
		const constructor = speechRecognition();
		if (!constructor?.available) return;
		for (const language of ["he-IL", "en-US"] as const) {
			void Promise.resolve()
				.then(() =>
					constructor.available?.({ langs: [language], processLocally: true }),
				)
				.then((status) => {
					if (status === "available") onDevice.current.add(language);
				})
				.catch(() => {});
		}
	}, []);
	const cancel = useCallback(() => {
		const session = current.current;
		if (!session) return;
		current.current = null;
		setPhase("idle");
		try {
			session.recognition.abort();
		} catch {
			/* Already ended. */
		}
	}, []);
	useEffect(() => {
		if (enabled) return cancel;
	}, [cancel, enabled, scope]);

	function toggle(language: Language) {
		const session = current.current;
		if (session) {
			setPhase("stopping");
			try {
				session.recognition.stop();
			} catch {
				cancel();
			}
			return;
		}
		const constructor = speechRecognition();
		if (!enabled || !constructor) return;
		setError("");
		const recognition = new constructor();
		const active = { recognition };
		current.current = active;
		recognition.lang = language;
		recognition.continuous = true;
		recognition.interimResults = false;
		if (onDevice.current.has(language) && "processLocally" in recognition)
			recognition.processLocally = true;
		let nextFinal = 0;
		const finish = () => {
			if (current.current !== active) return;
			current.current = null;
			setPhase("idle");
		};
		recognition.onresult = (event) => {
			if (current.current !== active) return;
			for (
				let index = Math.max(nextFinal, event.resultIndex);
				index < event.results.length;
				index++
			) {
				const result = event.results[index];
				if (result.isFinal) {
					onTranscript(result[0].transcript);
					nextFinal = index + 1;
				}
			}
		};
		recognition.onerror = (event) => {
			if (current.current !== active) return;
			setError(dictationError(event.error));
			finish();
		};
		recognition.onend = finish;
		try {
			recognition.start();
			setPhase("listening");
		} catch {
			setError(dictationError("start"));
			finish();
		}
	}
	return { supported, phase, error, cancel, toggle };
}

export function DictationControls({
	draft,
	dictation,
}: {
	draft: string;
	dictation: ReturnType<typeof useBrowserDictation>;
}) {
	const { locale } = useInterfaceLanguage();
	const [preferredLanguage, setPreferredLanguage] = useState<Language | null>(
		null,
	);
	const language =
		preferredLanguage ??
		dictationLanguage({
			draft,
			locale,
			browser: typeof navigator === "undefined" ? "" : navigator.language,
		});
	const { supported, phase } = dictation;
	const label = !supported
		? "Dictation is unavailable in this browser."
		: phase === "idle"
			? "Start dictation"
			: "Stop dictation";
	return (
		<div className={styles.dictation}>
			<LocalizedElement<typeof Button>
				element={Button}
				messageProps={["aria-label", "title"]}
				aria-label={label}
				title={label}
				aria-pressed={phase !== "idle"}
				disabled={!supported || phase === "stopping"}
				type="button"
				variant={phase === "idle" ? "ghost" : "outline"}
				size="icon"
				className="size-8"
				onClick={() => dictation.toggle(language)}
			>
				{phase === "idle" ? (
					<Mic size={15} aria-hidden />
				) : (
					<Square size={13} aria-hidden />
				)}
			</LocalizedElement>
			{supported && (
				<LocalizedElement<"select">
					element="select"
					messageProps={["aria-label"]}
					aria-label="Dictation language"
					value={language}
					disabled={phase !== "idle"}
					onChange={(event) =>
						setPreferredLanguage(
							event.target.value === "he-IL" ? "he-IL" : "en-US",
						)
					}
				>
					<option value="en-US" lang="en">
						EN
					</option>
					<option value="he-IL" lang="he">
						עב
					</option>
				</LocalizedElement>
			)}
			{phase !== "idle" && (
				<span className="sr-only" role="status">
					<Message text="Listening for dictation" />
				</span>
			)}
		</div>
	);
}
