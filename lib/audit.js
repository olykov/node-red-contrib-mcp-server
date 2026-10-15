"use strict";

const { createHash } = require('crypto');

// Short, non-reversible reference for session identifiers in logs.
function shortHash(value)
{
    return value ? createHash('sha256').update(String(value)).digest('hex').slice(0, 12) : undefined;
}

// One JSON line per security event. Callers pass identifiers only: never tokens, codes or tool arguments.
function auditLog(node, event, fields = {}, level = 'log')
{
    if (!node) return;
    const write = typeof node[level] === 'function' ? node[level] : node.log;
    if (typeof write !== 'function') return;
    const entry = { event };
    for (const [key, value] of Object.entries(fields))
    {
        if (value !== undefined && value !== null && value !== '') entry[key] = value;
    }
    write.call(node, JSON.stringify(entry));
}

module.exports = { auditLog, shortHash };
