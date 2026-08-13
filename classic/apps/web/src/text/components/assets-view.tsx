import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { DEFAULTS } from "@/timeline/defaults";
import { buildTextElement } from "@/timeline/element-utils";
import {
	EDITORIAL_TEXT_STYLES,
	type EditorialTextStyle,
} from "@/text/editorial-styles";
import type { ParamValues } from "@/params";
import type { MediaTime } from "@/wasm";

export function TextView() {
	const editor = useEditor();

	const handleAddToTimeline = ({
		currentTime,
		name,
		content,
		params,
	}: {
		currentTime: MediaTime;
		name: string;
		content: string;
		params?: Partial<ParamValues>;
	}) => {
		const activeScene = editor.scenes.getActiveScene();
		if (!activeScene) return;

		const element = buildTextElement({
			raw: {
				name,
				params: {
					...params,
					content,
				},
			},
			startTime: currentTime,
		});

		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
	};

	return (
		<PanelView title="Text">
			<div
				className="grid gap-2"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))" }}
			>
				<TextStyleItem
					id="default-text"
					name="Default text"
					content="Default text"
					onAddToTimeline={handleAddToTimeline}
				/>
				{EDITORIAL_TEXT_STYLES.map((style) => (
					<TextStyleItem
						key={style.id}
						id={style.id}
						name={style.name}
						content={style.sample}
						style={style}
						onAddToTimeline={handleAddToTimeline}
					/>
				))}
			</div>
		</PanelView>
	);
}

function TextStyleItem({
	id,
	name,
	content,
	style,
	onAddToTimeline,
}: {
	id: string;
	name: string;
	content: string;
	style?: EditorialTextStyle;
	onAddToTimeline: (input: {
		currentTime: MediaTime;
		name: string;
		content: string;
		params?: Partial<ParamValues>;
	}) => void;
}) {
	const color =
		typeof style?.params.color === "string" ? style.params.color : undefined;
	const shadowColor =
		typeof style?.params["shadow.color"] === "string"
			? style.params["shadow.color"]
			: undefined;
	const shadowBlur =
		typeof style?.params["shadow.blur"] === "number"
			? style.params["shadow.blur"]
			: 0;
	const shadowOffsetY =
		typeof style?.params["shadow.offsetY"] === "number"
			? style.params["shadow.offsetY"]
			: 0;

	return (
		<DraggableItem
			name={name}
			preview={
				<div
					className="flex size-full items-center justify-center rounded px-2"
					style={{
						background:
							style?.id === "editorial-feather-black"
								? "linear-gradient(135deg, #ffffff, #d9d9d9)"
								: "linear-gradient(135deg, #343434, #101010)",
					}}
				>
					<span
						className="text-center text-xs font-bold leading-tight select-none"
						style={{
							color,
							textShadow: shadowColor
								? `0 ${shadowOffsetY}px ${shadowBlur}px ${shadowColor}`
								: undefined,
						}}
					>
						{content}
					</span>
				</div>
			}
			dragData={{
				id,
				type: DEFAULTS.text.element.type,
				name,
				content,
				params: style?.params,
			}}
			aspectRatio={1}
			onAddToTimeline={({ currentTime }) =>
				onAddToTimeline({
					currentTime,
					name,
					content,
					params: style?.params,
				})
			}
			shouldShowLabel
		/>
	);
}
