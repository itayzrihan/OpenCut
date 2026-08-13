import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { KeyframeIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/utils/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function KeyframeToggle({
	isActive,
	isDisabled = false,
	title,
	onToggle,
	navigation,
}: {
	isActive: boolean;
	isDisabled?: boolean;
	title: string;
	onToggle: () => void;
	navigation?: {
		hasPrevious: boolean;
		hasNext: boolean;
		onPrevious: () => void;
		onNext: () => void;
	};
}) {
	return (
		<div className="mb-0.5 flex items-center gap-0.5">
			{navigation && (
				<Button
					variant="text"
					className="size-4 p-0 [&>svg]:size-3"
					disabled={!navigation.hasPrevious}
					title="Previous keyframe"
					aria-label="Previous keyframe"
					onClick={navigation.onPrevious}
				>
					<ChevronLeft />
				</Button>
			)}
			<Button
				variant="text"
				aria-pressed={isActive}
				disabled={isDisabled}
				title={title}
				onClick={onToggle}
				className="[&>svg]:size-3.5"
			>
				<HugeiconsIcon
					icon={KeyframeIcon}
					className={cn(isActive && "text-primary fill-primary")}
				/>
			</Button>
			{navigation && (
				<Button
					variant="text"
					className="size-4 p-0 [&>svg]:size-3"
					disabled={!navigation.hasNext}
					title="Next keyframe"
					aria-label="Next keyframe"
					onClick={navigation.onNext}
				>
					<ChevronRight />
				</Button>
			)}
		</div>
	);
}
