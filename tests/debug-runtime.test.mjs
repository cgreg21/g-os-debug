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

test('runtime authenticates protocol v1 without claiming engine-debugger features', () => {
    assert.match(source, /protocolVersion: RUNTIME_PROTOCOL_VERSION/);
    assert.match(source, /token: this\._token/);
    assert.match(source, /SpiderMonkey's Debugger API/);
    assert.doesNotMatch(source, /setBreakpoints|Debugger\.onNewScript|Debugger\.onEnterFrame/);
});
