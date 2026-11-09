"use client";
import {
	Message as UiMessage,
	LocalizedElement as UiLocalized,
} from "@/i18n/message";
import { useEffect, useMemo, useRef, useState } from "react";
import { Code2, Loader2, Play, Plus, Square } from "lucide-react";
import { toast } from "@/i18n/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEditor } from "@/editor/use-editor";
import { EARSHOT_SOUNDS, createEarshotSpec } from "../catalog";
import { previewEarshotSound } from "../audio";
import { buildEarshotElement } from "../element";

export function EarshotLibrary() {
	const editor = useEditor();
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState("");
	const [playing, setPlaying] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const preview = useRef<AbortController | null>(null);
	useEffect(() => () => preview.current?.abort(), []);
	const categories = useMemo(
		() => [...new Set(EARSHOT_SOUNDS.map((s) => s.category))].sort(),
		[],
	);
	const sounds = useMemo(
		() =>
			EARSHOT_SOUNDS.filter(
				(s) =>
					(!category || s.category === category) &&
					`${s.name} ${s.id} ${s.category}`
						.toLowerCase()
						.includes(query.toLowerCase()),
			),
		[query, category],
	);
	const play = async (id: string) => {
		preview.current?.abort();
		if (playing === id) {
			setPlaying(null);
			setLoading(false);
			return;
		}
		const controller = new AbortController();
		preview.current = controller;
		setPlaying(id);
		setLoading(true);
		try {
			await previewEarshotSound({
				spec: createEarshotSpec(id),
				signal: controller.signal,
				onEnded: () => {
					if (preview.current === controller) setPlaying(null);
				},
			});
		} catch (error) {
			if (!controller.signal.aborted) {
				toast.error(
					error instanceof Error ? error.message : "Could not play code sound",
				);
				setPlaying(null);
			}
		} finally {
			if (!controller.signal.aborted) setLoading(false);
		}
	};
	return (
		<div className="flex h-full min-h-0 flex-col gap-3" data-earshot-library>
			<p className="text-muted-foreground text-xs">
				{EARSHOT_SOUNDS.length}{" "}
				<UiMessage
					text={
						"editable code sounds · drag into the timeline or add at the playhead."
					}
				/>
			</p>
			<UiLocalized<typeof Input>
				element={Input}
				messageProps={["aria-label", "placeholder"]}
				aria-label="Search Earshot sounds"
				placeholder="Search code sounds…"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
			/>
			<UiLocalized<"select">
				element={"select"}
				messageProps={["aria-label"]}
				aria-label="Earshot category"
				className="bg-input rounded border px-2 py-1 text-xs"
				value={category}
				onChange={(e) => setCategory(e.target.value)}
			>
				<UiLocalized<"option">
					element={"option"}
					messageProps={["children"]}
					value=""
				>
					{"All categories"}
				</UiLocalized>
				{categories.map((c) => (
					<option key={c} value={c}>
						{c.replaceAll("_", " ")}
					</option>
				))}
			</UiLocalized>
			<UiLocalized<"div">
				element={"div"}
				messageProps={["aria-label"]}
				className="min-h-0 flex-1 overflow-y-auto"
				role="list"
				aria-label="Earshot code sounds"
			>
				{sounds.map((sound) => (
					<div
						key={sound.id}
						role="listitem"
						className="group flex min-h-16 items-center gap-2 border-b py-2"
						data-earshot-id={sound.id}
						draggable
						onDragStart={(event) => {
							const element = buildEarshotElement({
								spec: createEarshotSpec(sound.id),
								name: sound.name,
							});
							editor.timeline.dragSource.begin({
								dataTransfer: event.dataTransfer,
								dragData: {
									type: "element-bundle",
									id: sound.id,
									name: sound.name,
									anchorElementType: "audio",
									duration: element.duration,
									items: [{ trackType: "audio", element }],
								},
							});
						}}
						onDragEnd={() => editor.timeline.dragSource.end()}
					>
						<Button
							variant="ghost"
							size="icon"
							aria-label={`${playing === sound.id ? "Stop" : "Preview"} ${sound.name}`}
							onClick={() => void play(sound.id)}
						>
							{playing === sound.id ? (
								loading ? (
									<Loader2 className="animate-spin" />
								) : (
									<Square />
								)
							) : (
								<Play />
							)}
						</Button>
						<div className="min-w-0 flex-1">
							<p className="truncate text-sm" title={sound.id}>
								{sound.name}
							</p>
							<div className="text-muted-foreground flex items-center gap-2 text-[10px]">
								<span className="flex items-center gap-1 text-violet-400">
									<Code2 className="size-3" />{" "}
									<UiMessage text={"Code · Editable"} />
								</span>
								<span>{sound.duration.toFixed(2)}s</span>
							</div>
						</div>
						<Button
							variant="ghost"
							size="icon"
							aria-label={`Add ${sound.name} to timeline`}
							onClick={() => {
								try {
									editor.timeline.insertElement({
										placement: { mode: "auto", trackType: "audio" },
										element: buildEarshotElement({
											spec: createEarshotSpec(sound.id),
											name: sound.name,
											startTime: editor.playback.getCurrentTime(),
										}),
									});
								} catch (error) {
									toast.error(
										error instanceof Error
											? error.message
											: "Could not add code sound",
									);
								}
							}}
						>
							<Plus />
						</Button>
					</div>
				))}
				{!sounds.length && (
					<p className="text-muted-foreground py-4 text-sm">
						<UiMessage text={"No matching code sounds."} />
					</p>
				)}
			</UiLocalized>
			<p className="text-muted-foreground text-[10px]">
				<UiMessage
					text={"Earshot · MIT · includes credited CC0-derived recipes."}
				/>
			</p>
		</div>
	);
}
