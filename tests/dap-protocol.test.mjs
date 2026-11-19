import test from 'node:test';
import assert from 'node:assert/strict';
import { DapFrameDecoder, encodeDapMessage } from '../packages/protocol/dist/index.js';

test('decodes a complete DAP frame', () => {
    const decoder = new DapFrameDecoder();
    const message = { seq: 1, type: 'request', command: 'initialize', arguments: {} };
    assert.deepEqual(decoder.push(encodeDapMessage(message)), [message]);
});

test('handles partial frames and multiple frames in one chunk', () => {
    const decoder = new DapFrameDecoder();
    const first = encodeDapMessage({ seq: 1, type: 'request', command: 'threads' });
    const second = encodeDapMessage({ seq: 2, type: 'request', command: 'stackTrace' });
    assert.deepEqual(decoder.push(first.subarray(0, 9)), []);
    assert.deepEqual(decoder.push(Buffer.concat([first.subarray(9), second])), [
        { seq: 1, type: 'request', command: 'threads' },
        { seq: 2, type: 'request', command: 'stackTrace' },
    ]);
});

test('rejects invalid frame headers', () => {
    const decoder = new DapFrameDecoder();
    assert.throws(() => decoder.push('X-Other: 1\r\n\r\n{}'), /Content-Length/);
});
