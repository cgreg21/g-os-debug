import { DapFrameDecoder, encodeDapMessage, type DapMessage } from '@g-os-debug/protocol';

let sequence = 1;
const decoder = new DapFrameDecoder();

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

function handle(request: DapMessage): void {
    if (request.type !== 'request' || typeof request.command !== 'string') return;
    switch (request.command) {
        case 'initialize':
            response(request, true, {
                supportsConfigurationDoneRequest: true,
                supportsConditionalBreakpoints: false,
                supportsHitConditionalBreakpoints: false,
                supportsEvaluateForHovers: false,
                supportsStepBack: false,
                supportsSetVariable: false,
                supportsTerminateRequest: true,
                supportsTerminateDebuggee: true,
            });
            send({ seq: sequence++, type: 'event', event: 'initialized' });
            break;
        case 'launch':
        case 'attach':
            response(request, false, undefined,
                'No compatible GJS runtime is connected. Live debugging is unavailable; no breakpoints were installed.');
            break;
        case 'disconnect':
        case 'terminate':
            response(request, true);
            break;
        default:
            response(request, false, undefined, `Unsupported DAP request: ${request.command}`);
    }
}

process.stdin.on('data', (chunk: Buffer) => {
    try {
        for (const message of decoder.push(chunk)) handle(message);
    } catch (error) {
        process.stderr.write(`DAP input error: ${error instanceof Error ? error.message : String(error)}\\n`);
        process.exitCode = 1;
        process.stdin.pause();
    }
});
process.stdin.on('end', () => process.exit(0));
