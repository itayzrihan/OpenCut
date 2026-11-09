import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultInterfaceLocale, formatMessage, interfaceDirection, isInterfaceLocale } from "../apps/web/src/i18n/locales.ts";

const root = fileURLToPath(new URL("../apps/web/src/", import.meta.url));
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const ts = require("typescript");
const languages = ["he", "ar", "de", "ru"];
const catalogs = languages.map((locale) => JSON.parse(readFileSync(join(root, "i18n", "catalogs", `${locale}.json`), "utf8")));
const placeholders = (message) => (message.match(/\{\w+\}/g) ?? []).sort();
const messages = new Map();

function readMessage(value, file) {
	if (!value) return;
	if (ts.isJsxExpression(value)) readMessage(value.expression, file);
	else if (ts.isConditionalExpression(value)) {
		readMessage(value.whenTrue, file);
		readMessage(value.whenFalse, file);
	} else if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
		if (/[A-Za-z]{2,}/.test(value.text)) messages.set(value.text, file);
	}
}

function inspect(file) {
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	function visit(node) {
		if (ts.isCallExpression(node) && ["t", "localizeClientMessage"].includes(node.expression.getText(source))) {
			readMessage(node.arguments[0], file);
		} else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
			const tag = node.tagName.getText(source);
			const props = node.attributes.properties.filter(ts.isJsxAttribute);
			if (tag === "UiMessage" || tag === "Message") readMessage(props.find((prop) => prop.name.getText(source) === "text")?.initializer, file);
			if (tag === "UiLocalized" || tag === "LocalizedElement") {
				const names = props.find((prop) => prop.name.getText(source) === "messageProps")?.initializer?.expression;
				if (names && ts.isArrayLiteralExpression(names)) {
					for (const name of names.elements.filter(ts.isStringLiteral)) {
						if (name.text === "children" && ts.isJsxOpeningElement(node)) {
							for (const child of node.parent.children.filter(ts.isJsxExpression)) readMessage(child, file);
						} else readMessage(props.find((prop) => prop.name.getText(source) === name.text)?.initializer, file);
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
}

function walk(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name);
		if (entry.isDirectory() && !["api", "server", "__tests__", "fixtures"].includes(entry.name)) walk(file);
		else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(?:test|generated|fixture|spec|d)\./.test(entry.name)) inspect(file);
	}
}

walk(root);
const errors = [];
for (const [message, file] of messages) {
	for (const [index, catalog] of catalogs.entries()) {
		if (!Object.hasOwn(catalog, message) || !catalog[message].trim()) errors.push(`${languages[index]} missing ${JSON.stringify(message)} in ${file}`);
	}
}
for (const [index, catalog] of catalogs.entries()) {
	for (const [message, translation] of Object.entries(catalog)) {
		if (/__(?:he|ar|de|ru|en)__/i.test(translation)) errors.push(`${languages[index]} leaked a language token for ${JSON.stringify(message)}`);
		if (JSON.stringify(placeholders(message)) !== JSON.stringify(placeholders(translation))) errors.push(`${languages[index]} changed placeholders for ${JSON.stringify(message)}`);
	}
}
if (errors.length) {
	console.error(errors.join("\n"));
	process.exitCode = 1;
}
assert.equal(defaultInterfaceLocale, "en");
for (const locale of languages) assert.equal(isInterfaceLocale(locale), true);
for (const unsupported of [undefined, null, "fr", "ar-EG", "__proto__", "constructor"]) assert.equal(isInterfaceLocale(unsupported), false);
assert.deepEqual(["en", "he", "ar", "de", "ru"].map(interfaceDirection), ["ltr", "rtl", "rtl", "ltr", "ltr"]);
assert.equal(formatMessage({ catalog: { "{count} items in {project}": "{project}: {count}" }, message: "{count} items in {project}", values: { count: 2, project: "Test" } }), "Test: 2");
assert.equal(formatMessage({ catalog: {}, message: "constructor" }), "constructor");
if (!errors.length) console.log(`Verified ${messages.size} static UI messages in ${languages.length + 1} interface languages and preserved interpolation placeholders.`);
