import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMarkdown, messageDirection } from "../markdown";
test("Visu direction counts letters while code and each Markdown block keep their own direction", () => {
	for (const value of [
		"Overview רוב הטקסט הזה כתוב בעברית",
		"123 09:30 שלום",
		"שָׁלוֹם",
		"אa",
	])
		expect(messageDirection(value)).toBe("rtl");
	for (const value of ["שלום this text is mostly English", "123 😀", "", "aא"])
		expect(messageDirection(value)).toBe("ltr");
	const html = renderToStaticMarkup(
		<AgentMarkdown>
			{
				"# שלום וברוכים הבאים\n\nThis paragraph is English.\n\n```js\nconst title = 'שלום';\n```"
			}
		</AgentMarkdown>,
	);
	expect(html).toContain('<h1 dir="rtl">');
	expect(html).toContain('<p dir="ltr">');
	expect(html).toContain('<pre dir="ltr">');
	expect(html).toContain('class="language-js" dir="ltr"');
});
test("public summaries and answers reject raw HTML, executable links and authored image fetching", () => {
	const html = renderToStaticMarkup(
		<AgentMarkdown>
			{
				"<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![remote](https://example.com/tracking.png)\n\n[Source](https://example.com/reference)"
			}
		</AgentMarkdown>,
	);
	expect(html).not.toContain("<script");
	expect(html).not.toContain("javascript:");
	expect(html).not.toContain("<img");
	expect(html).toContain('rel="noopener noreferrer"');
});

test("Visu-style Markdown keeps numbered starts, mixed-direction tables and task lists", () => {
	const html = renderToStaticMarkup(
		<AgentMarkdown>
			{
				"3. בדיקה\n4. ייצוא\n\n| פעולה | Result |\n| --- | --- |\n| חיתוך | Complete |\n\n- [x] תיקון\n- [ ] ייצוא\n\n~~old~~"
			}
		</AgentMarkdown>,
	);
	expect(html).toContain('<ol start="3" dir="rtl">');
	expect(html).toContain('<th dir="rtl">פעולה</th>');
	expect(html).toContain('<th dir="ltr">Result</th>');
	expect(html).toContain('<td dir="rtl">חיתוך</td>');
	expect(html).toContain('<td dir="ltr">Complete</td>');
	expect(html).toContain('class="contains-task-list"');
	expect(html).toContain('disabled=""');
	expect(html).toContain("<del>old</del>");
	expect(html).not.toContain("[object Object]");
});
