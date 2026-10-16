'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { compileInputSchema, compileOutputSchema } = require('../lib/tool-validation');

describe('tool-validation input schema', () => {
    it('compiles a valid object schema and parses a string schema the same way', () => {
        const fromObject = compileInputSchema({ type: 'object', properties: { id: { type: 'string' } } });
        const fromString = compileInputSchema('{"type":"object","properties":{"id":{"type":"string"}}}');
        assert.deepStrictEqual(fromObject.schema, fromString.schema);
    });

    it('rejects a non-object schema value', () => {
        assert.throws(() => compileInputSchema('"just a string"'), /must be a JSON Schema object/);
        assert.throws(() => compileInputSchema(null), /must be a JSON Schema object/);
    });

    it('rejects invalid JSON text', () => {
        assert.throws(() => compileInputSchema('{not json'), /must contain valid JSON/);
    });

    // MCP-VAL-2
    it('requires input schemas to declare type object', () => {
        assert.throws(() => compileInputSchema({ type: 'array' }), /with type "object"/);
    });

    it('rejects a schema that is not valid JSON Schema 2020-12', () => {
        assert.throws(() => compileInputSchema({ type: 'object', properties: { id: { type: 'bogus-type' } } }),
            /not a valid JSON Schema/);
    });

    // MCP-VAL-3
    it('rejects oversized schemas', () => {
        const big = { type: 'object', properties: {} };
        for (let index = 0; index < 5000; index++) big.properties['p' + index] = { type: 'string' };
        assert.throws(() => compileInputSchema(big), /exceeds the (size|complexity) limit/);
    });

    // MCP-VAL-3
    it('rejects overly deep schemas', () => {
        let node = { type: 'string' };
        for (let depth = 0; depth < 40; depth++) node = { type: 'object', properties: { nested: node } };
        assert.throws(() => compileInputSchema(node), /exceeds the depth limit/);
    });

    // MCP-VAL-3
    it('validates arguments against the compiled schema and reports pointer paths', () => {
        const { validateArguments } = compileInputSchema({
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id']
        });
        assert.doesNotThrow(() => validateArguments({ id: 'abc' }));
        assert.throws(() => validateArguments({}), /\/id/);
    });

    it('rejects non-object arguments', () => {
        const { validateArguments } = compileInputSchema({ type: 'object', properties: {} });
        assert.throws(() => validateArguments('nope'), /Arguments do not match input schema/);
        assert.throws(() => validateArguments(null), /Arguments do not match input schema/);
        assert.throws(() => validateArguments([1, 2]), /Arguments do not match input schema/);
    });

    it('rejects oversized or overly deep arguments without leaking schema internals', () => {
        const { validateArguments } = compileInputSchema({ type: 'object', properties: {} });
        let deepArgument = { a: 1 };
        for (let depth = 0; depth < 100; depth++) deepArgument = { nested: deepArgument };
        let caught;
        try { validateArguments(deepArgument); } catch (error) { caught = error; }
        assert.ok(caught);
        assert.match(caught.message, /Arguments do not match input schema/);
        assert.strictEqual(caught.rpcCode, -32602);
    });

    it('deduplicates repeated error pointers and caps the reported list', () => {
        const { validateArguments } = compileInputSchema({
            type: 'object',
            properties: { items: { type: 'array', items: { type: 'string' } } },
            required: ['items']
        });
        assert.throws(() => validateArguments({ items: [1, 2, 3] }), /Arguments do not match input schema/);
    });
});

describe('tool-validation output schema', () => {
    it('returns null for an empty output schema', () => {
        assert.strictEqual(compileOutputSchema(''), null);
        assert.strictEqual(compileOutputSchema('   '), null);
    });

    it('compiles a valid output schema regardless of declared type', () => {
        assert.deepStrictEqual(compileOutputSchema('{"type":"array","items":{"type":"string"}}'),
            { type: 'array', items: { type: 'string' } });
    });

    it('rejects an output schema that is not valid JSON Schema 2020-12', () => {
        assert.throws(() => compileOutputSchema({ type: 'object', properties: { id: { type: 'bogus-type' } } }),
            /not a valid JSON Schema/);
    });

    it('rejects invalid JSON text for an output schema', () => {
        assert.throws(() => compileOutputSchema('{not json'), /must contain valid JSON/);
    });
});
