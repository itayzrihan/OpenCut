"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Film, ListVideo, Scissors, TextSelect, X } from "lucide-react";
import { toast } from "sonner";
import {
	useEditor,
	useEditorSelection,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
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
		description:
			"מיפוי רגעים מכל הפרק, חיבור שאלות, ניגודים ורגעי שיא לטיזר קצר, וביקורת תוכן לפני היצירה. נשמר ברצף חדש.",
	},
	{
		mode: "highlights",
		label: "קטעים חכמים מפודקאסט",
		icon: Scissors,
		description:
			"רעיונות חזקים מכל הפרק, עם פתיחה ברורה, דוגמה או תפנית וסיום בעל ערך. כל קטע עובר ביקורת ונשמר בסצנה חדשה.",
	},
	{
		mode: "chronological",
		label: "קטעים לפי סדר המקור",
		icon: ListVideo,
		description:
			"בחירת תשובות וסיפורים שלמים, קיצור חזרות וביקורת על החיתוכים, תוך שמירת סדר המקור. כל קטע נשמר בסצנה חדשה.",
	},
	{
		mode: "teleprompter",
		label: "חיתוכי טלפרומפטר",
		icon: TextSelect,
		description:
			"ניקוי חזרות והתחלות מחדש, שמירת כל משפט ייחודי וסדר התסריטים. כל סרטון בסצנה חדשה, עם טייקים חלופיים לבחירה לכל משפט.",
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
	const [showTakes, setShowTakes] = useState(false);
	const selected = modes.find((m) => m.mode === mode);
	const selectedElements = useEditorSelection((e) =>
		e.selection.getSelectedElements(),
	);
	const reference = useMemo(() => {
		if (!scene) return null;
		try {
			return editor.command.podcastScope(
				selectedElements.map((e) => e.elementId),
			);
		} catch {
			return null;
		}
	}, [editor, scene, selectedElements]);
	const unavailable = !reference;

	const run = async () => {
		if (!mode) return;
		setMode(null);
		try {
			await task.start({
				mode,
				minSeconds:
					mode === "teleprompter"
						? 0
						: mode === "teaser"
							? Math.max(20, seconds - 15)
							: 20,
				maxSeconds:
					mode === "teleprompter" ? 0 : mode === "teaser" ? seconds : 90,
				maxOutputs:
					mode === "teleprompter" ? 32 : mode === "teaser" ? 1 : count,
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};
	return (
		<div className="mb-4 space-y-3 rounded-md border p-3" dir="rtl">
			<p className="text-xs text-muted-foreground">
				{selectedElements.length
					? "מקור העריכה: טווחי הקליפים המסומנים בלבד, עם זוויות המצלמה והאודיו המסונכרן שלהם."
					: "מקור העריכה: כל הטיימליין הפעיל, כולל עריכת המולטיקאם."}
			</p>
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
					<Button
						variant="outline"
						size="sm"
						disabled={running}
						onClick={() =>
							void editor.scenes.switchToScene({
								sceneId: scene.podcastExtract!.sourceSceneId,
							})
						}
					>
						פתח את סצנת המקור להפקה נוספת
					</Button>
					<p>פתיחה: {scene.podcastExtract.openingHook}</p>
					<p>סיום: {scene.podcastExtract.endingHook}</p>
					{scene.podcastExtract.options.mode === "teleprompter" &&
						scene.takeAssembly && (
							<details
								className="space-y-2"
								onToggle={(event) => setShowTakes(event.currentTarget.open)}
							>
								<summary className="cursor-pointer">
									טייקים חלופיים לפי משפט (
									{
										scene.takeAssembly.plan.groups.filter(
											(g) => g.alternatives.length > 1 || g.reviewOnly,
										).length
									}
									)
								</summary>
								{showTakes &&
									scene.takeAssembly.plan.groups.map(
										(group, groupIndex) =>
											(group.alternatives.length > 1 || group.reviewOnly) && (
												<label key={groupIndex} className="block space-y-1">
													<span>
														{group.label}
														{group.reviewOnly
															? " · שמור לבדיקה, מחוץ לעריכה"
															: ""}
													</span>
													<select
														className="w-full rounded border bg-background p-2"
														aria-label={`טייק: ${group.label}`}
														disabled={running}
														value={group.reviewOnly ? "review" : group.selected}
														onChange={(event) => {
															try {
																editor.command.selectSmartTake({
																	groupIndex,
																	alternativeIndex: Number(event.target.value),
																});
															} catch (error) {
																toast.error(
																	error instanceof Error
																		? error.message
																		: String(error),
																);
															}
														}}
													>
														{group.reviewOnly && (
															<option value="review" disabled>
																שמור לבדיקה — לא נכלל בסרטון
															</option>
														)}
														{group.alternatives.map((alternative, index) => (
															<option key={index} value={index}>
																{index + 1}. {alternative.label} —{" "}
																{alternative.reason}
															</option>
														))}
													</select>
												</label>
											),
									)}
							</details>
						)}
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
					בחר סצנה עם וידאו או אודיו בטיימליין כדי להתחיל.
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
							{selected?.description} כל תוצאה נשמרת כרצף נפרד. הווידאו
							והכתוביות בפרק המקורי נשארים ללא שינוי, ואפשר להפיק ממנו שוב.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 px-6">
						{mode === "teleprompter" ? (
							<p className="text-sm">
								אפשר להשתמש בהקלטה אחת או בכמה קבצים. זיהוי הסרטונים ואורכם
								אוטומטי, ללא מגבלת 90 שניות; עד 32 תסריטים בכל הפקה. החלופות
								יופיעו כאן ובקליק ימני על הקליפים. ההמלצה מבוססת על התמלול; אפשר
								להאזין ולבחור טייק אחר.
							</p>
						) : mode === "teaser" ? (
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
								mode === "teleprompter"
									? false
									: mode === "teaser"
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
