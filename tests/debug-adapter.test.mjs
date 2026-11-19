import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DapFrameDecoder, encodeDapMessage } from '../packages/protocol/dist/index.js';

test('adapter initializes and refuses launch without a real GJS runtime', async () => {
    const child = spawn(process.execPath, ['packages/debug-adapter/dist/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new DapFrameDecoder();
    const received = [];
    child.stdout.on('data', chunk => received.push(...decoder.push(chunk)));
    child.stdin.write(encodeDapMessage({ seq: 1, type: 'request', command: 'initialize', arguments: {} }));
    await new Promise(resolve => setTimeout(resolve, 30));
    child.stdin.write(encodeDapMessage({ seq: 2, type: 'request', command: 'launch', arguments: {} }));
    await new Promise(resolve => setTimeout(resolve, 30));
    child.stdin.end();
    await once(child, 'exit');
    const initialize = received.find(message => message.type === 'response' && message.request_seq === 1);
    const launch = received.find(message => message.type === 'response' && message.request_seq === 2);
    assert.equal(initialize.success, true);
    assert.equal(launch.success, false);
    assert.match(launch.message, /No compatible GJS runtime/);
});
