'use strict';

// Verifies every requirement ID in docs/spec.md for the released sections (3, 4 and the
// section 6 invariants) has either a test reference (`// MCP-XXX-N` in test/**/*.js) or a
// review mark (an entry in REVIEW.md). Section 5 (the 4.0 contract) is excluded until that
// release starts.

const fs = require('node:fs');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const specPath = path.join(repository, 'docs', 'spec.md');
const reviewPath = path.join(repository, 'REVIEW.md');
const testDirectory = path.join(repository, 'test');

// Sections whose requirements must already have a test or review mark. Section 5 (4.0) is
// intentionally excluded: it is still in design and not yet implemented.
const ENFORCED_SECTIONS = new Set(['3', '4', '6']);

function parseSpec(markdown) {
    const lines = markdown.split('\n');
    let currentSection = null;
    const requirements = [];
    for (const line of lines) {
        const sectionMatch = line.match(/^##\s+(\d+)\./);
        if (sectionMatch) {
            currentSection = sectionMatch[1];
            continue;
        }
        const rowMatch = line.match(/^\|\s*(MCP-[A-Z]+-\d+)(?:\s*\(REV-\d+\))?\s*\|.*\|\s*([a-zA-Z]+)\s*\|\s*$/);
        if (rowMatch && currentSection) {
            requirements.push({ id: rowMatch[1], verification: rowMatch[2].toLowerCase(), section: currentSection });
        }
    }
    return requirements;
}

function collectTestText() {
    const files = fs.readdirSync(testDirectory, { recursive: true })
        .filter(name => name.endsWith('.test.js'))
        .map(name => path.join(testDirectory, name));
    return files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
}

function main() {
    const spec = fs.readFileSync(specPath, 'utf8');
    const requirements = parseSpec(spec).filter(req => ENFORCED_SECTIONS.has(req.section));
    const testText = collectTestText();
    const reviewText = fs.existsSync(reviewPath) ? fs.readFileSync(reviewPath, 'utf8') : '';

    const superseded = new Set([...reviewText.matchAll(/^\|\s*(MCP-[A-Z]+-\d+)\s*\|\s*superseded\s*\|/gm)].map(match => match[1]));
    const missing = [];
    for (const req of requirements) {
        if (superseded.has(req.id)) continue;
        const idPattern = new RegExp(`\\b${req.id}\\b`);
        if (req.verification === 'review') {
            if (!idPattern.test(reviewText)) missing.push(req);
        } else {
            if (!idPattern.test(testText)) missing.push(req);
        }
    }

    if (missing.length > 0) {
        console.error(`check-req-ids: ${missing.length} requirement(s) without a test or review mark:`);
        for (const req of missing) {
            const where = req.verification === 'review' ? 'REVIEW.md' : 'test/**/*.test.js';
            console.error(`  ${req.id} (${req.verification}) — expected a reference in ${where}`);
        }
        process.exitCode = 1;
        return;
    }

    console.log(`check-req-ids: ${requirements.length} requirement(s) all have a test or review mark` +
        (superseded.size ? `, ${superseded.size} superseded.` : '.'));
}

main();
