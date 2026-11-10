// Probe: does typebox's Value.Errors report problems inside Type.Record entries?
// Run from the repository root: node docs/probes/typebox-record.mjs
import { Type } from "typebox";
import { Value } from "typebox/value";

const Entry = Type.Object({ x: Type.Number() }, { additionalProperties: false });
const cases = {
	"Record alone, entry missing x": [Type.Record(Type.String(), Entry), { k: { y: 1 } }],
	"Record alone, entry with wrong type": [Type.Record(Type.String(), Entry), { k: { x: "s" } }],
	"Record inside Object, entry missing x": [Type.Object({ d: Type.Record(Type.String(), Entry) }), { d: { k: { y: 1 } } }],
	"Record inside Object with other errors": [
		Type.Object({ a: Type.String(), d: Type.Record(Type.String(), Entry) }, { additionalProperties: false }),
		{ a: 1, q: 2, d: { k: { y: 1 } } },
	],
};
for (const [label, [schema, value]] of Object.entries(cases)) {
	const errors = Value.Errors(schema, value).map((e) => `${e.instancePath || "/"} ${e.keyword}: ${e.message}`);
	console.log(`${label}: Check=${Value.Check(schema, value)}`);
	for (const e of errors) console.log(`    ${e}`);
}

// Value.Errors returns at most 8 errors (observed with typebox 1.3.27). A value with more than
// eight problems hides the later ones; this is why an earlier probe seemed to skip Record entries.
const many = Type.Object({ a: Type.String(), b: Type.String(), c: Type.String(), d: Type.String(), e: Type.String(),
	f: Type.String(), g: Type.String(), h: Type.String(), i: Type.String(), j: Type.String() });
const tenWrong = Object.fromEntries("abcdefghij".split("").map((k) => [k, 1]));
console.log(`ten wrong fields: Value.Errors returned ${Value.Errors(many, tenWrong).length} errors`);
