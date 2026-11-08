// @opencut-test-runner: node
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
	assertSupportedJsonSchema,
	validateJsonSchemaValue,
} from "@deepseek-ai/dsh-tools";

test("DSH accepts ordinary and foreign-realm JSON schemas in the host runtime", () => {
	for (const schema of [
		{ type: "string", enum: ["ready", "failed"] },
		runInNewContext('({type:"string", enum:["ready","failed"]})'),
	]) {
		assert.doesNotThrow(() => assertSupportedJsonSchema(schema));
		assert.deepEqual(validateJsonSchemaValue(schema, "ready", ""), []);
		assert.ok(validateJsonSchemaValue(schema, "other", "").length);
	}
});

test("DSH retains prototype and lossless-JSON rejection after the runtime compatibility patch", () => {
	const forgedPrototype = Object.create(null);
	Object.defineProperty(forgedPrototype, "constructor", { value: Object });
	const forged = Object.assign(Object.create(forgedPrototype), {
		type: "string",
	});
	for (const candidate of [
		forged,
		new Date(),
		{ type: "string", extra: () => {} },
	]) {
		assert.throws(() => assertSupportedJsonSchema(candidate));
	}
	assert.doesNotThrow(() =>
		assertSupportedJsonSchema(
			Object.assign(Object.create(null), { type: "string" }),
		),
	);
});
