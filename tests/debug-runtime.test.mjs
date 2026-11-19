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
    assert.match(source, /getActorId/);
    assert.match(source, /_actorsById/);
    assert.match(source, /highlightActor/);
    assert.match(source, /clearHighlight/);
    assert.match(source, /get_transformed_position/);
    assert.match(source, /g-os-debug-highlight-overlay/);
    assert.doesNotMatch(source, /get_text\(\)|get_property\(|setBreakpoints/);
});
