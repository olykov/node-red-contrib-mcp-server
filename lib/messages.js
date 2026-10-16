'use strict';

const fs = require('node:fs');
const path = require('node:path');

const catalogs = new Map();

function loadCatalog(file)
{
    if (!catalogs.has(file))
    {
        try
        {
            catalogs.set(file, JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'en-US', file + '.json'), 'utf8')));
        } catch { catalogs.set(file, {}); }
    }
    return catalogs.get(file);
}

// Resolves a message key such as "nr-mcp-endpoint.status.running" through the Node-RED catalog
// of the node (node._), falling back to the shipped en-US catalog when no runtime i18n exists.
function message(node, file, key, vars)
{
    if (node && typeof node._ === 'function')
    {
        const translated = node._(key, vars);
        if (typeof translated === 'string' && translated && translated !== key && !translated.endsWith(key)) return translated;
    }
    let value = loadCatalog(file);
    for (const part of key.split('.')) value = value && value[part];
    if (typeof value !== 'string') return key;
    return value.replace(/\{\{(\w+)\}\}/g, (_, name) => vars && vars[name] !== undefined ? String(vars[name]) : '');
}

module.exports = { message };
