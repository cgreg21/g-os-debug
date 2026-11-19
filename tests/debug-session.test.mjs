import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDebugSession } from '../packages/session-controller/dist/index.js';

async function createConnectedSession() {
    const dir = await mkdtemp(join(tmpdir(), 'g-os-session-'));
    const socketPath = join(dir, 'runtime.sock');
    const session = await createDebugSession({ socketPath, runtimeVersion: 'test', requestTimeoutMs: 500 });
    const socket = connect(socketPath);
    socket.setEncoding('utf8');
    let input = '';
    const messages = [];
    socket.on('data', chunk => {
        input += chunk;
        let newline;
        while ((newline = input.indexOf('\n')) >= 0) {
            messages.push(JSON.parse(input.slice(0, newline)));
            input = input.slice(newline + 1);
        }
    });
    socket.write(JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        adapterVersion: 'test',
        token: session.token,
    }) + '\n');
    await session.waitForRuntime();
    return { dir, session, socket, messages };
}

test('session exposes runtime connection state and waits for authenticated runtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g-os-session-'));
    const session = await createDebugSession({ socketPath: join(dir, 'runtime.sock'), runtimeVersion: 'test' });
    try {
        assert.equal(session.state, 'waiting');
        const waiting = session.waitForRuntime(1000);
        const socket = connect(session.socketPath);
        socket.write(JSON.stringify({ type: 'hello', protocolVersion: 1, adapterVersion: 'test', token: session.token }) + '\n');
        await waiting;
        assert.equal(session.state, 'connected');
        socket.destroy();
    } finally {
        await session.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('session correlates a stage inspection response with its request', async () => {
    const { dir, session, socket, messages } = await createConnectedSession();
    try {
        const result = session.inspectStage({ maxDepth: 3, maxNodes: 25 });
        await new Promise(resolve => setTimeout(resolve, 10));
        const command = messages.find(message => message.type === 'inspectStage');
        assert.deepEqual(command, { type: 'inspectStage', id: 1, maxDepth: 3, maxNodes: 25 });
        socket.write(JSON.stringify({
            type: 'stageSnapshot',
            id: command.id,
            root: { id: 1, typeName: 'Stage', name: null, visible: true, mapped: true, childCount: 0, allocation: null, children: [] },
            truncated: false,
        }) + '\n');
        const snapshot = await result;
        assert.equal(snapshot.root.typeName, 'Stage');
        assert.equal(snapshot.truncated, false);
    } finally {
        socket.destroy();
        await session.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('session rejects inspection while runtime is disconnected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g-os-session-'));
    const session = await createDebugSession({ socketPath: join(dir, 'runtime.sock'), runtimeVersion: 'test' });
    try {
        await assert.rejects(session.inspectStage(), /not connected/);
    } finally {
        await session.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('session rejects pending inspection when runtime disconnects', async () => {
    const { dir, session, socket, messages } = await createConnectedSession();
    try {
        const result = session.inspectStage({ timeoutMs: 1000 });
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(messages.some(message => message.type === 'inspectStage'));
        socket.destroy();
        await assert.rejects(result, /disconnected/);
    } finally {
        await session.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('session times out an inspection request that receives no response', async () => {
    const { dir, session, socket } = await createConnectedSession();
    try {
        await assert.rejects(session.inspectStage({ timeoutMs: 30 }), /Timed out/);
    } finally {
        socket.destroy();
        await session.close();
        await rm(dir, { recursive: true, force: true });
    }
});
