import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../packages/debug-runtime/src/index.js', import.meta.url), 'utf8');

test('GJS runtime uses Gio Unix sockets and asynchronous stream I/O', () => {
    assert.match(source, /Gio\.UnixSocketAddress\.new/);
    assert.match(source, /connect_async/);
    assert.match(source, /read_line_async/);
    assert.match(source, /write_all_async/);
    assert.doesNotMatch(source, /node:net|node:fs|process\.env/);
});

test('runtime implements bounded, read-only Clutter stage snapshots', () => {
    assert.match(source, /snapshotStage/);
    assert.match(source, /get_children\(\)/);
    assert.match(source, /get_allocation_box\(\)/);
    assert.match(source, /DEFAULT_MAX_DEPTH/);
    assert.match(source, /DEFAULT_MAX_NODES/);
    assert.match(source, /inspectStage/);
    assert.match(source, /stageSnapshot/);
    assert.doesNotMatch(source, /get_text\(\)|get_property\(|setBreakpoints/);
});
