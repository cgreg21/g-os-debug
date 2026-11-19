import { DapFrameDecoder, encodeDapMessage, type DapMessage } from '@g-os-debug/protocol';
import { createDebugSession, type DebugSession } from '@g-os-debug/session-controller';

let sequence = 1;
const decoder = new DapFrameDecoder();
let session: DebugSession | undefined;
let sessionInitialization: Promise<DebugSession> | undefined;

function send(message: DapMessage): void {
    process.stdout.write(encodeDapMessage(message));
}

function response(request: DapMessage, success: boolean, body?: unknown, message?: string): void {
    send({
        seq: sequence++,
        type: 'response',
        request_seq: request.seq,
        command: request.command,
        success,
        ...(body === undefined ? {} : { body }),
        ...(message ? { message } : {}),
    });
}

function getSession(): Promise<DebugSession> {
    if (session) return Promise.resolve(session);
    if (sessionInitialization) return sessionInitialization;
    const socketPath = process.env.GOS_DEBUG_SOCKET_PATH;
    const token = process.env.GOS_DEBUG_RUNTIME_TOKEN;
    if (!socketPath || !token)
        return Promise.reject(new Error('Inspector session is not configured. Set GOS_DEBUG_SOCKET_PATH and GOS_DEBUG_RUNTIME_TOKEN.'));
    sessionInitialization = createDebugSession({
        socketPath,
        token,
        runtimeVersion: '0.1.0',
        requestTimeoutMs: 3000,
    }).then(created => {
        session = created;
        session.onStateChanged(state => send({
            seq: sequence++,
            type: 'event',
            event: 'gOs/sessionState',
            body: { state },
        }));
        return created;
    }).catch(error => {
        sessionInitialization = undefined;
        throw error;
    });
    return sessionInitialization;
}

async function handle(request: DapMessage): Promise<void> {
    if (request.type !== 'request' || typeof request.command !== 'string') return;
    switch (request.command) {
        case 'initialize':
            response(request, true, {
                supportsConfigurationDoneRequest: false,
                supportsConditionalBreakpoints: false,
                supportsHitConditionalBreakpoints: false,
                supportsEvaluateForHovers: false,
                supportsStepBack: false,
                supportsSetVariable: false,
                supportsTerminateRequest: true,
                supportsTerminateDebuggee: false,
            });
            send({ seq: sequence++, type: 'event', event: 'initialized' });
            break;
        case 'gOs/sessionStatus':
            try {
                const current = await getSession();
                response(request, true, { state: current.state, inspectorAvailable: current.state === 'connected' });
            } catch (error) {
                response(request, false, undefined, error instanceof Error ? error.message : String(error));
            }
            break;
        case 'gOs/inspectStage':
            try {
                const current = await getSession();
                const args = (request.arguments ?? {}) as { maxDepth?: number; maxNodes?: number; timeoutMs?: number };
                const snapshot = await current.inspectStage(args);
                response(request, true, snapshot);
            } catch (error) {
                response(request, false, undefined, error instanceof Error ? error.message : String(error));
            }
            break;
        case 'launch':
        case 'attach':
            response(request, false, undefined,
                'Live JavaScript debugging is unavailable: the SpiderMonkey debugger engine is not integrated. Use gOs/inspectStage for read-only scene inspection.');
            break;
        case 'disconnect':
        case 'terminate':
            response(request, true);
            if (session) {
                await session.close();
                session = undefined;
                sessionInitialization = undefined;
            }
            break;
        default:
            response(request, false, undefined, `Unsupported DAP request: ${request.command}`);
    }
}

process.stdin.on('data', (chunk: Buffer) => {
    try {
        for (const message of decoder.push(chunk)) {
            void handle(message).catch(error => {
                if (message.type === 'request')
                    response(message, false, undefined, error instanceof Error ? error.message : String(error));
            });
        }
    } catch (error) {
        process.stderr.write(`DAP input error: ${error instanceof Error ? error.message : String(error)}\\n`);
        process.exitCode = 1;
        process.stdin.pause();
    }
});
process.stdin.on('end', () => {
    void session?.close().finally(() => process.exit(0)) ?? process.exit(0);
});
