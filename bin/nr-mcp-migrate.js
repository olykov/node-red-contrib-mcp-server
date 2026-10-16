#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { migrateFlow } = require('../lib/migration');

const USAGE = 'Usage: nr-mcp-migrate --input <flows.json> --output <new-flows.json>\n' +
    'Converts a 3.x flow to the 4.0 node types. The output must be a new file; the report is printed as JSON.\n' +
    'Exit code: 0 migrated, 1 migrated with manual review items, 2 usage or file error.';

function parseArgs(argv)
{
    const args = {};
    for (let index = 0; index < argv.length; index++)
    {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') return { help: true };
        if (arg !== '--input' && arg !== '--output') throw new Error('Unknown argument: ' + arg);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(arg + ' needs a file path');
        args[arg.slice(2)] = value;
    }
    if (!args.input || !args.output) throw new Error('--input and --output are required');
    return args;
}

function main(argv)
{
    let args;
    try
    {
        args = parseArgs(argv);
    } catch (error)
    {
        process.stderr.write(error.message + '\n' + USAGE + '\n');
        return 2;
    }
    if (args.help)
    {
        process.stdout.write(USAGE + '\n');
        return 0;
    }
    const input = path.resolve(args.input);
    const output = path.resolve(args.output);
    try
    {
        if (input === output) throw new Error('--output must differ from --input');
        const result = migrateFlow(JSON.parse(fs.readFileSync(input, 'utf8')));
        fs.writeFileSync(output, JSON.stringify(result.flow, null, 4) + '\n', { flag: 'wx' });
        process.stdout.write(JSON.stringify({ input, output, converted: result.converted,
            unchanged: result.unchanged, manualReview: result.manualReview }, null, 2) + '\n');
        return result.manualReview.length ? 1 : 0;
    } catch (error)
    {
        process.stderr.write((error.code === 'EEXIST' ? 'Output file already exists: ' + output : error.message) + '\n');
        return 2;
    }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
