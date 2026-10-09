"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Film, ListVideo, Scissors, X } from "lucide-react";
import { toast } from "sonner";
import { useEditor, useEditorTimelineScenes } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { getPodcastTask } from "../podcast-task";
import type { PodcastMode } from "../podcast-types";
const modes = [
	{
		mode: "teaser",
		label: "יצירת טיזר",
		icon: Film,
		description: "הרגע הכי חזק בפתיחה, סיפור מחובר וסיום שמשאיר ציפייה להמשך.",
	},
	{
		mode: "highlights",
		label: "קטעים חכמים מפודקאסט",
		icon: Scissors,
		description:
			"סרטונים של 20–90 שניות מרגעים חזקים בכל כחמש דקות. אפשר לשנות את סדר הקטעים.",
	},
	{
		mode: "chronological",
		label: "קטעים לפי סדר המקור",
		icon: ListVideo,
		description:
			"סרטונים של 20–90 שניות, עם קיצור חזרות ושמירה על סדר הדברים בפרק.",
	},
] as const;
export function PodcastControls({
	disabled = false,
	onRunningChange,
}: {
	disabled?: boolean;
	onRunningChange?: (running: boolean) => void;
}) {
	const editor = useEditor();
	const scene = useEditorTimelineScenes((e) => e.scenes.getActiveSceneOrNull());
	const task = getPodcastTask(editor);
	const status = useSyncExternalStore(
		task.subscribe,
		task.getSnapshot,
		task.getSnapshot,
	);
	const running = status.status === "running";
	useEffect(() => onRunningChange?.(running), [running, onRunningChange]);
	const [mode, setMode] = useState<PodcastMode | null>(null);
	const [seconds, setSeconds] = useState(60);
	const [count, setCount] = useState(24);
	const selected = modes.find((m) => m.mode === mode);
	const unavailable =
		!scene?.tracks.main.elements.some((e) => e.type === "video") ||
		!!scene?.takeAssembly;
	const run = async () => {
		if (!mode) return;
		setMode(null);
		try {
			await task.start({
				mode,
				minSeconds: mode === "teaser" ? Math.max(20, seconds - 15) : 20,
				maxSeconds: mode === "teaser" ? seconds : 90,
				maxOutputs: mode === "teaser" ? 1 : count,
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};
	return (
		<div className="mb-4 space-y-3 rounded-md border p-3" dir="rtl">
			{modes.map((item) => (
				<div key={item.mode} className="space-y-1">
					<Button
						className="w-full"
						variant="outline"
						disabled={disabled || running || unavailable}
						onClick={() => setMode(item.mode)}
					>
						<item.icon className="size-4" />
						{item.label}
					</Button>
					<p className="text-xs text-muted-foreground">{item.description}</p>
				</div>
			))}
			{scene?.podcastExtract && (
				<div className="space-y-1 rounded border p-2 text-xs" dir="auto">
					<p className="font-medium">{scene.podcastExtract.title}</p>
					<p>פתיחה: {scene.podcastExtract.openingHook}</p>
					<p>סיום: {scene.podcastExtract.endingHook}</p>
					{!!scene.takeAssembly?.quality?.unverifiedBoundaries && (
						<p role="status" className="text-amber-600">
							יש לבדוק בהאזנה {scene.takeAssembly.quality.unverifiedBoundaries}{" "}
							גבולות חיתוך ללא שתיקה מאומתת.
						</p>
					)}
				</div>
			)}
			{unavailable && (
				<p className="text-xs text-muted-foreground">
					פתח את רצף הפרק המקורי עם הווידאו המלא כדי להתחיל.
				</p>
			)}
			{running && (
				<div className="flex items-center gap-2">
					<Spinner className="size-4" />
					<span
						role="status"
						aria-live="polite"
						className="min-w-0 flex-1 text-xs"
						dir="auto"
					>
						{status.stage}
					</span>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Cancel podcast analysis"
						onClick={task.cancel}
					>
						<X />
					</Button>
				</div>
			)}
			{status.status === "succeeded" && (
				<p role="status" className="text-xs">
					נוצרו {status.outputCount} רצפים לעריכה. אפשר לעבור ביניהם בחלונית
					Media או בתפריט הרצפים בציר הזמן.
				</p>
			)}
			{status.status === "failed" && (
				<p role="alert" className="text-xs text-destructive" dir="auto">
					{status.error}
				</p>
			)}
			{status.status === "cancelled" && (
				<p role="status" className="text-xs">
					הניתוח בוטל. לא נוצרו קטעים.
				</p>
			)}
			<Dialog
				open={!!mode}
				onOpenChange={(open) => {
					if (!open) setMode(null);
				}}
			>
				<DialogContent dir="rtl">
					<DialogHeader>
						<DialogTitle>{selected?.label}</DialogTitle>
						<DialogDescription>
							{selected?.description} כל תוצאה נשמרת כרצף נפרד, והפרק המקורי
							נשאר זמין.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 px-6">
						{mode === "teaser" ? (
							<label
								htmlFor="podcast-teaser-duration"
								className="block space-y-2 text-sm"
							>
								אורך מרבי לטיזר, בשניות
								<Input
									id="podcast-teaser-duration"
									type="number"
									min={20}
									max={90}
									value={Number.isFinite(seconds) ? seconds : ""}
									onChange={(event) => setSeconds(event.target.valueAsNumber)}
								/>
							</label>
						) : (
							<label
								htmlFor="podcast-output-count"
								className="block space-y-2 text-sm"
							>
								מספר מרבי של סרטונים
								<Input
									id="podcast-output-count"
									type="number"
									min={1}
									max={32}
									value={Number.isFinite(count) ? count : ""}
									onChange={(event) => setCount(event.target.valueAsNumber)}
								/>
							</label>
						)}
						<p className="text-xs text-muted-foreground">
							אם אין תמלול, ניצור אותו תחילה. התמלול נשאר גם אם הניתוח מבוטל.
							מספר התוצאות תלוי באיכות החומר; חיתוכים ללא שתיקה מאומתת יסומנו
							לבדיקה. בטיזר הסיום יכול להשאיר רעיון פתוח, אבל לא לחתוך מילה
							באמצע.
						</p>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setMode(null)}>
							סגור
						</Button>
						<Button
							disabled={
								mode === "teaser"
									? !Number.isInteger(seconds) || seconds < 20 || seconds > 90
									: !Number.isInteger(count) || count < 1 || count > 32
							}
							onClick={() => void run()}
						>
							צור רצפים
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
