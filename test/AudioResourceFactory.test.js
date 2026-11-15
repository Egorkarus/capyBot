const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StreamType } = require('@discordjs/voice');

const { createFileResource, logStreamFailure } = require('../src/utils/AudioResourceFactory');

test('createFileResource отдаёт stereo opus потоком с StreamType.OggOpus', async () => {
    const stream = { on() {} };
    const calls = [];
    const resource = { mocked: true };

    const result = await createFileResource('/tmp/stereo.opus', {
        readChannels: async () => 2,
        createStream: target => {
            calls.push(['stream', target]);
            return stream;
        },
        createResource: (...args) => {
            calls.push(['resource', ...args]);
            return resource;
        }
    });

    assert.equal(result, resource);
    assert.equal(calls[0][0], 'stream');
    assert.equal(calls[0][1], '/tmp/stereo.opus');

    const resourceCall = calls[1];
    assert.equal(resourceCall[0], 'resource');
    assert.equal(resourceCall[1], stream);
    assert.equal(resourceCall[2].inputType, StreamType.OggOpus);
});

test('createFileResource отдаёт моно-файл прежним путём по filePath', async () => {
    const calls = [];

    const result = await createFileResource('/tmp/mono.opus', {
        readChannels: async () => 1,
        createStream: () => assert.fail('createStream must not be called for mono files'),
        createResource: (...args) => {
            calls.push(args);
            return 'mono-resource';
        }
    });

    assert.equal(result, 'mono-resource');
    assert.deepEqual(calls, [['/tmp/mono.opus']]);
});

test('createFileResource отдаёт прежним путём не-opus файл', async () => {
    const calls = [];

    const result = await createFileResource('/tmp/video.webm', {
        readChannels: async () => null,
        createStream: () => assert.fail('createStream must not be called for non-opus files'),
        createResource: (...args) => {
            calls.push(args);
            return 'fallback-resource';
        }
    });

    assert.equal(result, 'fallback-resource');
    assert.deepEqual(calls, [['/tmp/video.webm']]);
});

test('logStreamFailure: штатный premature close идёт в debug, не в error', () => {
    let debugCalls = 0;
    let errorCalls = 0;

    logStreamFailure('x.opus', { code: 'ERR_STREAM_PREMATURE_CLOSE' }, {
        logDebug: () => { debugCalls += 1; },
        logError: () => { errorCalls += 1; }
    });

    assert.equal(debugCalls, 1);
    assert.equal(errorCalls, 0);
});

test('logStreamFailure: реальная ошибка чтения идёт в error, не в debug', () => {
    let debugCalls = 0;
    let errorCalls = 0;

    logStreamFailure('x.opus', new Error('ENOENT'), {
        logDebug: () => { debugCalls += 1; },
        logError: () => { errorCalls += 1; }
    });

    assert.equal(errorCalls, 1);
    assert.equal(debugCalls, 0);
});
