'use strict';

// Pending tool calls keyed by executionId. A call that ended by cancellation or timeout stays
// retired for the longest tool timeout so that its late response is recognised and ignored.
const RETIRE_MS = 600000;
const pending = new Map();
const retired = new Map();

function errorText(error)
{
    if (typeof error === 'string') return error;
    if (error && typeof error.message === 'string') return error.message;
    return JSON.stringify(error);
}

function add(executionId, entry)
{
    pending.set(executionId, entry);
}

function take(executionId)
{
    const entry = pending.get(executionId);
    if (entry) pending.delete(executionId);
    return entry;
}

function retire(executionId)
{
    clearTimeout(retired.get(executionId));
    const timer = setTimeout(() => retired.delete(executionId), RETIRE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    retired.set(executionId, timer);
}

function isRetired(executionId)
{
    return retired.has(executionId);
}

function entries()
{
    return Array.from(pending.entries());
}

module.exports = { add, take, retire, isRetired, entries, errorText };
