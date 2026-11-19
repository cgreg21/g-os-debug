import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DapFrameDecoder, encodeDapMessage } from '../packages/protocol/dist/index.js';

function startAdapter(env = {}) {
    const child = spawn(process.execPath, ['packages/debug-adapter/dist/index.js'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
    });
    const decoder = new DapFrameDecoder();
    const received = [];
    child.stdout.on('data', chunk => received.push(...decoder.push(chunk)));
    const send = (seq, command, args = {}) => child.stdin.write(encodeDapMessage({
        seq, type: 'request', command, arguments: args,
    }));
    const waitFor = async predicate => {
        for (let attempt = 0; attempt < 100; attempt++) {
            const found = received.find(predicate);
            if (found) return found;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('Timed out waiting for DAP response');
    };
    return { child, received, send, waitFor };
}

test('adapter initializes and refuses JavaScript debugging without an engine', async () => {
    const adapter = startAdapter();
    adapter.send(1, 'initialize');
    const initialize = await adapter.waitFor(m => m.type === 'response' && m.request_seq === 1);
    adapter.send(2, 'attach');
    const attach = await adapter.waitFor(m => m.type === 'response' && m.request_seq === 2);
    assert.equal(initialize.success, true);
    assert.equal(attach.success, false);
    assert.match(attach.message, /SpiderMonkey debugger engine is not integrated/);
    adapter.child.stdin.end();
    await once(adapter.child, 'exit');
});

test('adapter exposes a real runtime stage snapshot through its custom DAP request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g-os-dap-'));
    const socketPath = join(dir, 'runtime.sock');
    const token = 'a'.repeat(64);
    const adapter = startAdapter({
        GOS_DEBUG_SOCKET_PATH: socketPath,
        GOS_DEBUG_RUNTIME_TOKEN: token,
    });
    let runtime;
    try {
        adapter.send(1, 'gOs/sessionStatus');
        const initialStatus = await adapter.waitFor(m => m.type === 'response' && m.request_seq === 1);
        assert.equal(initialStatus.body.state, 'waiting');
        runtime = connect(socketPath);
        runtime.setEncoding('utf8');
        let input = '';
        runtime.on('data', chunk => {
            input += chunk;
            const newline = input.indexOf('\n');
            if (newline >= 0) {
                const handshake = JSON.parse(input.slice(0, newline));
                assert.equal(handshake.type, 'hello');
            }
        });
        runtime.write(JSON.stringify({
            type: 'hello', protocolVersion: 1, adapterVersion: 'test', token,
        }) + '\n');
        await adapter.waitFor(m => m.type === 'response' && m.request_seq === 1 && m.success === true);
        adapter.send(2, 'gOs/inspectStage', { maxDepth: 2, maxNodes: 10 });
        let commandBuffer = '';
        const command = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('No inspection command received')), 1000);
            runtime.on('data', chunk => {
                commandBuffer += chunk;
                const newline = commandBuffer.indexOf('\n');
                if (newline >= 0) {
                    clearTimeout(timeout);
                    resolve(JSON.parse(commandBuffer.slice(0, newline)));
                }
            });
        });
        assert.equal(command.type, 'inspectStage');
        assert.equal(command.maxDepth, 2);
        runtime.write(JSON.stringify({
            type: 'stageSnapshot',
            id: command.id,
            root: { id: 1, typeName: 'Clutter.Stage', name: null, visible: true, mapped: true, childCount: 0, allocation: null, children: [] },
            truncated: false,
        }) + '\n');
        const response = await adapter.waitFor(m => m.type === 'response' && m.request_seq === 2);
        assert.equal(response.success, true);
        assert.equal(response.body.root.typeName, 'Clutter.Stage');
    } finally {
        runtime?.destroy();
        adapter.child.stdin.end();
        await once(adapter.child, 'exit');
        await rm(dir, { recursive: true, force: true });
    }
});

test('adapter reports missing inspector configuration', async () => {
    const adapter = startAdapter({ GOS_DEBUG_SOCKET_PATH: '', GOS_DEBUG_RUNTIME_TOKEN: '' });
    adapter.send(1, 'gOs/sessionStatus');
    const response = await adapter.waitFor(m => m.type === 'response' && m.request_seq === 1);
    assert.equal(response.success, false);
    assert.match(response.message, /not configured/);
    adapter.child.stdin.end();
    await once(adapter.child, 'exit');
});
