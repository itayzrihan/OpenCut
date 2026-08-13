import { describe, expect, test } from "bun:test";
import {
	AI_SKILLS,
	listAiSkills,
	loadAiSkill,
	loadAiSkillResource,
} from "@/ai/skills";
import { hyperframeGraphicDefinition } from "@/graphics/definitions/hyperframe";
import { getHyperframeRasterTimeBucket } from "@/graphics/html-raster";

describe("AI skills", () => {
	test("lists every skill with name and description only", () => {
		const listed = listAiSkills();
		expect(listed).toHaveLength(AI_SKILLS.length);
		expect(listed.map((skill) => skill.name)).toEqual([
			"creative-direction",
			"hyperframe-authoring",
			"motion-graphics",
			"text-effects",
			"opencut-workspace",
			"video-workflows",
			"paper-grid-editorial",
		]);
		for (const skill of listed) {
			expect(skill.description.length).toBeGreaterThan(0);
			expect("content" in skill).toBe(false);
		}
	});

	test("loads skills by name, tolerating slash prefixes and casing", () => {
		const creativeDirection = loadAiSkill({ name: "creative-direction" });
		expect(creativeDirection?.description).toContain("amazing");
		expect(creativeDirection?.description).toContain("VFX");
		expect(creativeDirection?.description).toContain("SFX");
		expect(creativeDirection?.content).toContain(
			"make defensible creative choices, and proceed to a reviewed plan",
		);
		expect(creativeDirection?.content).toContain("map its real beats");
		expect(creativeDirection?.content).toContain(
			"Explicit requested dimensions are hard requirements",
		);
		expect(creativeDirection?.content).toContain(
			"the final plan must address sound",
		);
		expect(creativeDirection?.content).toContain(
			"the final plan must include supported content-specific effect work",
		);
		expect(creativeDirection?.content).toContain(
			"Do not add categories just to fill a quota",
		);
		expect(loadAiSkill({ name: "hyperframe-authoring" })?.content).toContain(
			"--hf-delay",
		);
		expect(loadAiSkill({ name: "/Motion-Graphics" })?.name).toBe(
			"motion-graphics",
		);
		expect(loadAiSkill({ name: "unknown" })).toBeNull();
	});

	test("projects the Paper Grid Editorial skill and loads references on demand", () => {
		const skill = loadAiSkill({ name: "/Paper-Grid-Editorial" });
		expect(skill?.content).toContain("Non-negotiable contract");
		expect(skill?.content).toContain("three frames per second");
		expect(skill?.resourceNames).toEqual([
			"references/compositing-depth.md",
			"references/editorial-grammar.md",
			"references/hebrew-reference-project-profile.md",
			"references/hyperframes-remotion-synthesis.md",
			"references/i-recorded-three-times-full-analysis.md",
			"references/kallaway-day1-full-analysis.md",
			"references/lmsme-preview-first-minute.md",
			"references/minimal-product-ui-assets.md",
			"references/quality-gates.md",
			"references/video-mp4-full-analysis.md",
			"references/virtual-camera-canvas.md",
		]);

		const reference = loadAiSkillResource({
			name: "paper-grid-editorial",
			resource: "references/lmsme-preview-first-minute.md",
		});
		expect(reference?.content).toContain("180 JPEG frames");
		expect(reference?.content).toContain("| 59-60 |");
		const fullVideoReference = loadAiSkillResource({
			name: "paper-grid-editorial",
			resource: "references/video-mp4-full-analysis.md",
		});
		expect(fullVideoReference?.content).toContain("all 155 samples at 3fps");
		expect(fullVideoReference?.content).toContain(
			"Detect gaps on the original dialogue clip",
		);
		const threeTakeReference = loadAiSkillResource({
			name: "paper-grid-editorial",
			resource: "references/i-recorded-three-times-full-analysis.md",
		});
		expect(threeTakeReference?.content).toContain("all 170 samples at 3fps");
		expect(threeTakeReference?.content).toContain(
			"Repetition without duplicate-layer bugs",
		);
		expect(threeTakeReference?.content).toContain(
			"Seventeen word-timed speech gaps",
		);
		const frameBreakoutReference = loadAiSkillResource({
			name: "paper-grid-editorial",
			resource: "references/kallaway-day1-full-analysis.md",
		});
		expect(frameBreakoutReference?.content).toContain(
			"655 labeled samples at 10 fps",
		);
		expect(frameBreakoutReference?.content).toContain(
			"create_speaker_frame_breakout",
		);
		expect(frameBreakoutReference?.content).toContain(
			"One and only one audible speaker source",
		);
		const uiAssetReference = loadAiSkillResource({
			name: "paper-grid-editorial",
			resource: "references/minimal-product-ui-assets.md",
		});
		expect(uiAssetReference?.content).toContain("No orphaned one-offs");
		expect(uiAssetReference?.content).toContain("saveAsUiElement");
		expect(
			loadAiSkillResource({
				name: "paper-grid-editorial",
				resource: "../SKILL.md",
			}),
		).toBeNull();
	});
});

describe("hyperframe graphic definition", () => {
	test("derives source size from params with clamping", () => {
		expect(
			hyperframeGraphicDefinition.sourceSize?.({
				params: { html: "", sourceWidth: 1280, sourceHeight: 720 },
			}),
		).toEqual({ width: 1280, height: 720 });
		expect(
			hyperframeGraphicDefinition.sourceSize?.({
				params: { html: "", sourceWidth: 1, sourceHeight: 999_999 },
			}),
		).toEqual({ width: 16, height: 4096 });
		expect(
			hyperframeGraphicDefinition.sourceSize?.({
				params: { html: "" },
			}),
		).toEqual({ width: 1920, height: 1080 });
	});

	test("buckets raster time at 30fps for cache stability", () => {
		expect(getHyperframeRasterTimeBucket({ timeSeconds: 0 })).toBe(0);
		expect(getHyperframeRasterTimeBucket({ timeSeconds: 0.5 })).toBe(0.5);
		expect(getHyperframeRasterTimeBucket({ timeSeconds: 1.001 })).toBeCloseTo(
			1,
			5,
		);
	});
});
