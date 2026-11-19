import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';

test('VS Code extension is bundled and has no unresolved workspace imports', () => {
    const bundlePath = 'packages/vscode-extension/dist/extension.js';
    assert.ok(existsSync(bundlePath), 'VS Code extension bundle must be generated');
    const bundle = readFileSync(bundlePath, 'utf8');
    assert.match(bundle, /exports\.activate/);
    assert.doesNotMatch(bundle, /from\s+["']@g-os-debug\//);
    assert.doesNotMatch(bundle, /require\(["']@g-os-debug\//);
});
