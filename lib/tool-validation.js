'use strict';

const Ajv2020 = require('ajv/dist/2020');

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 2000;
const MAX_ARGUMENT_DEPTH = 64;
const MAX_ARGUMENT_NODES = 20000;
const MAX_REPORTED_ERRORS = 20;
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });

function isRecord(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkJsonBounds(value, maxDepth, maxNodes, maxBytes, label)
{
    let serialized;
    try
    {
        serialized = JSON.stringify(value);
    } catch
    {
        throw new Error(label + ' must be valid JSON');
    }
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes)
        throw new Error(label + ' exceeds the size limit');

    const stack = [{ value, depth: 0 }];
    let nodes = 0;
    while (stack.length)
    {
        const current = stack.pop();
        if (++nodes > maxNodes) throw new Error(label + ' exceeds the complexity limit');
        if (current.depth > maxDepth) throw new Error(label + ' exceeds the depth limit');
        if (current.value && typeof current.value === 'object')
        {
            for (const child of Object.values(current.value))
                stack.push({ value: child, depth: current.depth + 1 });
        }
    }
}

function parseSchema(value, label, requireObjectType)
{
    let schema;
    try
    {
        schema = typeof value === 'string' ? JSON.parse(value) : value;
    } catch
    {
        throw new Error(label + ' must contain valid JSON');
    }
    if (!isRecord(schema) || (requireObjectType && schema.type !== 'object'))
        throw new Error(label + ' must be a JSON Schema object' +
            (requireObjectType ? ' with type "object"' : ''));

    checkJsonBounds(schema, MAX_SCHEMA_DEPTH, MAX_SCHEMA_NODES, MAX_SCHEMA_BYTES, label);
    return schema;
}

function compileInputSchema(value)
{
    const schema = parseSchema(value, 'Input schema', true);
    let validate;
    try
    {
        validate = ajv.compile(schema);
    } catch
    {
        throw new Error('Input schema is not a valid JSON Schema 2020-12 document');
    }

    return {
        schema,
        validateArguments(argumentsValue)
        {
            if (!isRecord(argumentsValue)) throw invalidArguments(['/']);
            try
            {
                checkJsonBounds(argumentsValue, MAX_ARGUMENT_DEPTH, MAX_ARGUMENT_NODES,
                    MAX_SCHEMA_BYTES, 'Arguments');
            } catch
            {
                throw invalidArguments(['/']);
            }
            if (validate(argumentsValue)) return;

            const paths = Array.from(new Set((validate.errors || []).slice(0, MAX_REPORTED_ERRORS).map(error =>
            {
                let path = error.instancePath || '/';
                if (error.keyword === 'required' && error.params && error.params.missingProperty)
                    path = (path === '/' ? '' : path) + '/' +
                        String(error.params.missingProperty).replace(/~/g, '~0').replace(/\//g, '~1');
                return path;
            })));
            throw invalidArguments(paths.length ? paths : ['/']);
        }
    };
}

function compileOutputSchema(value)
{
    if (typeof value === 'string' && !value.trim()) return null;
    const schema = parseSchema(value, 'Output schema', false);
    try
    {
        ajv.compile(schema);
    } catch
    {
        throw new Error('Output schema is not a valid JSON Schema 2020-12 document');
    }
    return schema;
}

function invalidArguments(paths)
{
    const error = new Error('Arguments do not match input schema at: ' + paths.join(', '));
    error.rpcCode = -32602;
    return error;
}

module.exports = { compileInputSchema, compileOutputSchema };
