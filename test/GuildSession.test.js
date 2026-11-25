const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');

const config = require('../src/config');
const GuildSession = require('../src/structures/GuildSession');
const SafeHttpClient = require('../src/utils/SafeHttpClient');
const YtDlpClient = require('../src/utils/YtDlpClient');
const AudioResourceFactory = require('../src/utils/AudioResourceFactory');

function createSession(t) {
    const session = new GuildSession('guild-1', 'voice-1', 'text-1');
    t.after(async () => {
        await session.destroy();
    });
    return session;
}

function stubInternalCounter(session, startedValue) {
    const calls = { count: 0 };
    session._playNextTrackInternal = async () => {
        calls.count += 1;
        return startedValue;
    };
    return calls;
}

const CONFIG_MODULE_PATH = require.resolve('../src/config');
const GUILD_SESSION_MODULE_PATH = require.resolve('../src/structures/GuildSession');

// config читает env при загрузке модуля, а GuildSession закрывает его в замыкании,
// поэтому для разных env нужен сброс require.cache обоих модулей.
function loadMaxFileSizeLimitBytes() {
    delete require.cache[CONFIG_MODULE_PATH];
    delete require.cache[GUILD_SESSION_MODULE_PATH];
    return require(GUILD_SESSION_MODULE_PATH).getMaxFileSizeLimitBytes();
}

function restoreModules() {
    delete require.cache[CONFIG_MODULE_PATH];
    delete require.cache[GUILD_SESSION_MODULE_PATH];
    require(CONFIG_MODULE_PATH);
    require(GUILD_SESSION_MODULE_PATH);
}

function withEnv(variables, run) {
    const saved = {};
    for (const name of Object.keys(variables)) {
        saved[name] = process.env[name];
        if (variables[name] === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = variables[name];
        }
    }

    try {
        return run();
    } finally {
        for (const name of Object.keys(saved)) {
            if (saved[name] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = saved[name];
            }
        }
    }
}

function collectSentText(session) {
    const sent = [];
    session.textChannel = {
        send: async text => {
            sent.push(text);
            return {};
        }
    };
    return sent;
}

test('конструктор создаёт сессию без голосового соединения', { timeout: 5000 }, async t => {
    const session = createSession(t);

    assert.equal(session.guildId, 'guild-1');
    assert.equal(session.voiceChannelId, 'voice-1');
    assert.equal(session.textChannelId, 'text-1');
    assert.ok(session.player);
    assert.deepEqual(session.tracks, []);
    assert.equal(session.isProcessing, false);
    assert.equal(session.destroyed, false);
});

test('playNextTrack: три подряд вызова дают два прогона (первый + pending)', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const calls = stubInternalCounter(session, false);

    const firstCall = session.playNextTrack();
    const secondCall = session.playNextTrack();
    const thirdCall = session.playNextTrack();
    await Promise.all([firstCall, secondCall, thirdCall]);

    assert.equal(calls.count, 2);
    assert.equal(session.isProcessing, false);
});

test('playNextTrack: при started=true повторный вызов не запускает второй прогон', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const calls = stubInternalCounter(session, true);

    const firstCall = session.playNextTrack();
    const secondCall = session.playNextTrack();
    await Promise.all([firstCall, secondCall]);

    assert.equal(calls.count, 1);
    assert.equal(session.isProcessing, false);
});

test('destroyed: addTrack и playNextTrack не запускают обработку', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const calls = stubInternalCounter(session, true);

    await session.destroy();
    session.addTrack('https://example.com/a.mp3', 'track');
    await session.playNextTrack();

    assert.equal(calls.count, 0);
    assert.equal(session.tracks.length, 0);
});

test('_send глотает ошибку отправки сообщения', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const originalConsoleError = console.error;
    console.error = () => {};

    t.after(() => {
        console.error = originalConsoleError;
    });

    const failingChannel = {
        send: () => Promise.reject(new Error('boom'))
    };

    await assert.doesNotReject(session._send(failingChannel, 'text'));
});

test('_scheduleNextAfterCurrent ставит таймер, _clearPendingTimers и stop его снимают', { timeout: 5000 }, async t => {
    const session = createSession(t);
    session.tracks.push({ url: 'https://example.com/a.mp3', title: 'track' });

    session._scheduleNextAfterCurrent();
    assert.equal(session.pendingTimers.size, 1);

    session._clearPendingTimers();
    assert.equal(session.pendingTimers.size, 0);

    session._scheduleNextAfterCurrent();
    assert.equal(session.pendingTimers.size, 1);

    await session.stop();
    assert.equal(session.pendingTimers.size, 0);
});

test('_scheduleNextAfterCurrent не ставит таймер на пустой очереди', { timeout: 5000 }, async t => {
    const session = createSession(t);

    session._scheduleNextAfterCurrent();

    assert.equal(session.pendingTimers.size, 0);
});

test('_scheduleNextAfterCurrent не обрывает уже играющий трек', { timeout: 5000 }, async t => {
    const session = createSession(t);
    session.tracks.push({ url: 'https://example.com/a.mp3', title: 'track' });

    const originalState = Object.getOwnPropertyDescriptor(session.player, 'state');
    Object.defineProperty(session.player, 'state', {
        configurable: true,
        writable: true,
        value: { status: AudioPlayerStatus.Playing }
    });

    try {
        session._scheduleNextAfterCurrent();

        assert.equal(session.pendingTimers.size, 0);
    } finally {
        // Возвращаем настоящее состояние: внутренний AudioPlayer.stop()
        // читает resource из state и упал бы на заглушке.
        if (originalState) {
            Object.defineProperty(session.player, 'state', originalState);
        } else {
            delete session.player.state;
        }
    }
});

test('skip, stop и destroy прерывают активную загрузку', { timeout: 5000 }, async t => {
    const session = createSession(t);

    const controller = {
        aborted: false,
        abort() {
            this.aborted = true;
        }
    };
    session.downloadController = controller;

    await session.skip();
    assert.equal(controller.aborted, true);

    controller.aborted = false;
    await session.stop();
    assert.equal(controller.aborted, true);

    controller.aborted = false;
    await session.destroy();
    assert.equal(controller.aborted, true);
});

test('_playNextTrackInternal не запускает плеер, если сессию уничтожили во время ожидания', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const SafeHttpClient = require('../src/utils/SafeHttpClient');

    let playCalls = 0;
    session.player.play = () => {
        playCalls += 1;
        return true;
    };
    session._send = async () => {};
    session._ensureConnectionReady = async () => {
        // destroy() прилетел, пока ждали готовность соединения.
        session.destroyed = true;
        return true;
    };

    const originalDownload = SafeHttpClient.download;
    SafeHttpClient.download = async () => {};
    t.after(() => {
        SafeHttpClient.download = originalDownload;
    });

    session.tracks.push({
        url: 'https://example.com/a.mp3',
        title: 'track',
        isLive: false,
        trackDurationMs: null
    });

    const started = await session._playNextTrackInternal();

    assert.equal(started, false);
    assert.equal(playCalls, 0);
    assert.equal(session.currentFilePath, null);
});

test('setConnection отклоняет соединение для уничтоженной сессии и закрывает его', { timeout: 5000 }, async t => {
    const session = createSession(t);

    const calls = { destroy: 0, subscribe: 0 };
    const connection = {
        destroy() {
            calls.destroy += 1;
        },
        subscribe() {
            calls.subscribe += 1;
            throw new Error('subscribe must not be called for a destroyed session');
        }
    };

    session.destroyed = true;
    const accepted = session.setConnection(connection, null);

    assert.equal(accepted, false);
    assert.equal(calls.destroy, 1);
    assert.equal(calls.subscribe, 0);
    assert.equal(session.connection, null);
});

test('_wakeQueueIfIdle будит очередь только в Idle-состоянии живой сессии', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const calls = { count: 0 };
    let releaseFirstRun = null;

    session._playNextTrackInternal = async () => {
        calls.count += 1;
        await new Promise(resolve => {
            releaseFirstRun = resolve;
        });
        return true;
    };
    session.tracks.push({ url: 'https://example.com/a.mp3', title: 'track' });

    // Прогон держится в работе, чтобы поймать isProcessing = true.
    const firstWake = session._wakeQueueIfIdle();
    assert.equal(calls.count, 1);
    assert.equal(session.isProcessing, true);

    // Повторное пробуждение не запускает второй прогон (guard isProcessing).
    await session._wakeQueueIfIdle();
    assert.equal(calls.count, 1);

    releaseFirstRun();
    await firstWake;
    assert.equal(session.isProcessing, false);

    // Мёртвая сессия не должна начинать воспроизведение.
    session.destroyed = true;
    await session._wakeQueueIfIdle();
    assert.equal(calls.count, 1);
});

test('_playNextTrackInternal возвращает трек в очередь, если соединение не готово', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const sent = collectSentText(session);

    session.player.play = () => {
        assert.fail('player.play must not be called when connection is not ready');
    };
    session._ensureConnectionReady = async () => false;

    const originalDownload = SafeHttpClient.download;
    SafeHttpClient.download = async () => {};
    t.after(() => {
        SafeHttpClient.download = originalDownload;
    });

    const track = { url: 'https://example.com/a.mp3', title: 'track', isLive: false, trackDurationMs: null };
    session.tracks.push(track);

    const started = await session._playNextTrackInternal();

    assert.equal(started, false);
    assert.equal(session.tracks.length, 1);
    assert.equal(session.tracks[0], track);
    assert.deepEqual(sent, [
        config.messages.downloading.replace('{title}', 'track'),
        config.messages.playerBroke
    ]);
});

test('skip во время ожидания соединения не дублирует и не теряет очередь', { timeout: 5000 }, async t => {
    const session = createSession(t);

    let playCalls = 0;
    session.player.play = () => {
        playCalls += 1;
        return true;
    };
    // Имитация skip: контроллер отменяется, пока ждём готовность соединения.
    session._ensureConnectionReady = async () => {
        session.downloadController?.abort();
        return true;
    };

    const originalDownload = SafeHttpClient.download;
    SafeHttpClient.download = async () => {};
    t.after(() => {
        SafeHttpClient.download = originalDownload;
    });

    const skippedTrack = { url: 'https://example.com/a.mp3', title: 'skipped', isLive: false, trackDurationMs: null };
    const nextTrack = { url: 'https://example.com/b.mp3', title: 'next', isLive: false, trackDurationMs: null };
    session.tracks.push(skippedTrack, nextTrack);

    const started = await session._playNextTrackInternal();

    // Фактическое поведение: отменённый (skip) трек не возвращается в очередь,
    // поэтому в очереди остаётся ровно один следующий трек, без дублей.
    assert.equal(started, false);
    assert.equal(playCalls, 0);
    assert.equal(session.tracks.length, 1);
    assert.equal(session.tracks[0], nextTrack);
});

test('N1: abort во время ожидания соединения не возвращает трек в очередь', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const sent = collectSentText(session);

    let playCalls = 0;
    session.player.play = () => {
        playCalls += 1;
        return true;
    };
    // skip: контроллер отменяется, пока ждём готовность соединения.
    session._ensureConnectionReady = async () => {
        session.downloadController?.abort();
        return false;
    };

    const originalDownload = SafeHttpClient.download;
    SafeHttpClient.download = async () => {};
    t.after(() => {
        SafeHttpClient.download = originalDownload;
    });

    const skippedTrack = { url: 'https://example.com/a.mp3', title: 'skipped', isLive: false, trackDurationMs: null };
    const nextTrack = { url: 'https://example.com/b.mp3', title: 'next', isLive: false, trackDurationMs: null };
    session.tracks.push(skippedTrack, nextTrack);

    const started = await session._playNextTrackInternal();

    // Возврат трека и playerBroke — только для живой сессии без отмены.
    assert.equal(started, false);
    assert.equal(playCalls, 0);
    assert.equal(session.tracks.length, 1);
    assert.equal(session.tracks[0], nextTrack);
    assert.equal(sent.includes(config.messages.playerBroke), false);
});

test('N1: уничтоженная сессия не возвращает трек и не шлёт playerBroke (destroyed во время ожидания соединения)', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const sent = collectSentText(session);

    let playCalls = 0;
    session.player.play = () => {
        playCalls += 1;
        return true;
    };
    // !leave/!stop прилетел, пока шло скачивание и ожидание соединения:
    // возврат трека и playerBroke для мёртвой сессии запрещены.
    session._ensureConnectionReady = async () => {
        session.destroyed = true;
        return false;
    };

    const originalDownload = SafeHttpClient.download;
    SafeHttpClient.download = async () => {};
    t.after(() => {
        SafeHttpClient.download = originalDownload;
    });

    session.tracks.push({ url: 'https://example.com/a.mp3', title: 'track', isLive: false, trackDurationMs: null });

    const started = await session._playNextTrackInternal();

    assert.equal(started, false);
    assert.equal(playCalls, 0);
    assert.equal(session.tracks.length, 0);
    assert.equal(sent.includes(config.messages.playerBroke), false);
});

test('_returnTrackIfAlive не возвращает трек для уничтоженной сессии', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const sent = collectSentText(session);
    session.destroyed = true;
    const track = { url: 'https://example.com/a.mp3', title: 'track' };

    await session._returnTrackIfAlive(track, { aborted: false }, session.textChannel);

    assert.equal(session.tracks.length, 0);
    assert.equal(sent.includes(config.messages.playerBroke), false);
    assert.equal(session.connectionRetryCount, 0);
});

test('M2: live-трек возвращается в очередь, стрим-джоба останавливается, игрок не запускается', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const sent = collectSentText(session);

    let playCalls = 0;
    session.player.play = () => {
        playCalls += 1;
        return true;
    };
    session._ensureConnectionReady = async () => false;

    const calls = { stop: 0, create: 0 };
    const fakeJob = {
        stream: new PassThrough(),
        stop: async () => {
            calls.stop += 1;
        }
    };
    const originalCreateStreamJob = YtDlpClient.createStreamJob;
    YtDlpClient.createStreamJob = async (url, options) => {
        calls.create += 1;
        assert.equal(typeof options.signal?.aborted, 'boolean');
        return fakeJob;
    };
    t.after(() => {
        YtDlpClient.createStreamJob = originalCreateStreamJob;
    });

    const track = {
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        title: 'live track',
        isLive: true,
        trackDurationMs: null
    };
    session.tracks.push(track);

    const started = await session._playNextTrackInternal();

    assert.equal(started, false);
    assert.equal(playCalls, 0);
    assert.equal(calls.create, 1);
    assert.equal(session.tracks.length, 1);
    assert.equal(session.tracks[0], track);
    assert.equal(session.currentStreamJob, null);
    // Живая сессия: о неготовом соединении игрок предупреждается.
    assert.equal(sent.includes(config.messages.playerBroke), true);
    assert.equal(sent.includes(config.messages.liveStreamStarted.replace('{title}', 'live track')), true);
    assert.ok(calls.stop >= 1);
});

test('M2: live-трек не возвращается в очередь и не шлёт playerBroke при aborted-сигнале', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const sent = collectSentText(session);

    session.player.play = () => {
        assert.fail('player.play must not be called when connection is not ready');
    };
    // skip: контроллер отменяется, пока ждём готовность соединения.
    session._ensureConnectionReady = async () => {
        session.downloadController?.abort();
        return false;
    };

    const calls = { stop: 0 };
    const fakeJob = {
        stream: new PassThrough(),
        stop: async () => {
            calls.stop += 1;
        }
    };
    const originalCreateStreamJob = YtDlpClient.createStreamJob;
    YtDlpClient.createStreamJob = async () => fakeJob;
    t.after(() => {
        YtDlpClient.createStreamJob = originalCreateStreamJob;
    });

    session.tracks.push({
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        title: 'live track',
        isLive: true,
        trackDurationMs: null
    });

    const started = await session._playNextTrackInternal();

    assert.equal(started, false);
    assert.equal(session.tracks.length, 0);
    assert.equal(sent.includes(config.messages.playerBroke), false);
    assert.equal(session.currentStreamJob, null);
    assert.ok(calls.stop >= 1);
});

test('L2: возврат трека в очередь не запускает повторное скачивание в том же цикле', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const sent = collectSentText(session);

    let downloadCalls = 0;
    session.player.play = () => {
        assert.fail('player.play must not be called when connection is not ready');
    };
    // Внешний вызов (Idle/skip) взводит pendingNext, пока итерация в работе.
    session._ensureConnectionReady = async () => {
        session.pendingNext = true;
        return false;
    };

    const originalDownload = SafeHttpClient.download;
    SafeHttpClient.download = async () => {
        downloadCalls += 1;
    };
    t.after(() => {
        SafeHttpClient.download = originalDownload;
    });

    const track = { url: 'https://example.com/a.mp3', title: 'track', isLive: false, trackDurationMs: null };
    session.tracks.push(track);

    await session.playNextTrack();

    assert.equal(downloadCalls, 1);
    assert.equal(session.lastIterationRequeued, true);
    assert.equal(session.isProcessing, false);
    assert.equal(session.tracks.length, 1);
    assert.equal(session.tracks[0], track);
});

test('L1: ретрай после возврата трека ограничен, destroy снимает таймер', { timeout: 5000 }, async t => {
    const session = createSession(t);
    collectSentText(session);

    session.player.play = () => {
        assert.fail('player.play must not be called when connection is not ready');
    };
    session._ensureConnectionReady = async () => false;

    const originalDownload = SafeHttpClient.download;
    SafeHttpClient.download = async () => {};
    t.after(() => {
        SafeHttpClient.download = originalDownload;
    });

    session.tracks.push({ url: 'https://example.com/a.mp3', title: 'track', isLive: false, trackDurationMs: null });

    await session.playNextTrack();

    assert.equal(session.connectionRetryCount, 1);
    assert.ok(session.pendingTimers.size >= 1);

    await session.destroy();

    assert.equal(session.pendingTimers.size, 0);
});

test('getMaxFileSizeLimitBytes учитывает env-лимиты', { timeout: 5000 }, async t => {
    t.after(() => {
        restoreModules();
    });

    const fileSizeOnly = withEnv({ MAX_FILE_SIZE_BYTES: '1000', MAX_DOWNLOAD_BYTES: undefined },
        () => loadMaxFileSizeLimitBytes());
    assert.equal(fileSizeOnly, 1000);

    const defaultLimit = withEnv({ MAX_FILE_SIZE_BYTES: undefined, MAX_DOWNLOAD_BYTES: undefined },
        () => loadMaxFileSizeLimitBytes());
    assert.equal(defaultLimit, 70 * 1024 * 1024);

    const downloadLimit = withEnv({ MAX_FILE_SIZE_BYTES: undefined, MAX_DOWNLOAD_BYTES: '500' },
        () => loadMaxFileSizeLimitBytes());
    assert.equal(downloadLimit, 500);
});

test('_playNextTrackInternal не запускает плеер, если загрузку отменили до player.play', { timeout: 5000 }, async t => {
    const session = createSession(t);

    const workingDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'capybot-test-guildsession-'));
    const tempDirectory = path.join(workingDirectory, 'temp');
    await fsPromises.mkdir(tempDirectory);

    const originalWorkingDirectory = process.cwd();
    const originalDownloadFile = YtDlpClient.downloadFile;
    process.chdir(workingDirectory);

    t.after(async () => {
        YtDlpClient.downloadFile = originalDownloadFile;
        process.chdir(originalWorkingDirectory);
        await fsPromises.rm(workingDirectory, { recursive: true, force: true });
    });

    let playCalls = 0;
    session.player.play = () => {
        playCalls += 1;
        return true;
    };
    session._ensureConnectionReady = async () => true;
    // Файл реально создаётся, чтобы проверить его удаление после отмены.
    YtDlpClient.downloadFile = async (url, outputPathPattern) => {
        await fsPromises.writeFile(outputPathPattern.replace('.%(ext)s', '.mp3'), 'audio-bytes');
        session.downloadController.abort();
    };

    session.tracks.push({
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        title: 'platform track',
        isLive: false,
        trackDurationMs: null
    });

    const started = await session._playNextTrackInternal();

    assert.equal(started, false);
    assert.equal(playCalls, 0);
    assert.deepEqual(await fsPromises.readdir(tempDirectory), []);
});

test('setConnection не бросает, если логгер не экспортирует logDebug', { timeout: 5000 }, async t => {
    const logger = require('../src/utils/logger');
    const originalLogDebug = logger.logDebug;

    // На сервере при рассинхроне файлов logger.js старее GuildSession.js:
    // logDebug отсутствует, а stateChange-обработчик его вызывает.
    delete logger.logDebug;

    t.after(() => {
        logger.logDebug = originalLogDebug;
        delete require.cache[GUILD_SESSION_MODULE_PATH];
        require(GUILD_SESSION_MODULE_PATH);
    });

    delete require.cache[GUILD_SESSION_MODULE_PATH];
    const StaleLoggerGuildSession = require(GUILD_SESSION_MODULE_PATH);
    assert.equal(StaleLoggerGuildSession, require(GUILD_SESSION_MODULE_PATH));

    const session = new StaleLoggerGuildSession('guild-stale-logger', 'voice-stale-logger', 'text-stale-logger');
    t.after(async () => {
        await session.destroy();
    });

    const handlers = new Map();
    const connection = {
        on(event, handler) {
            handlers.set(event, handler);
            return connection;
        },
        subscribe() {
            // Прод-сценарий: stateChange эмитится синхронно внутри subscribe.
            handlers.get('stateChange')?.({ status: 'connecting' }, { status: 'ready' });
            return { unsubscribe() {} };
        },
        destroy() {}
    };

    const accepted = session.setConnection(connection, null);

    assert.equal(accepted, true);
    assert.equal(session.connection, connection);
    assert.equal(typeof session.subscription.unsubscribe, 'function');
});

test('stop очищает очередь, но не уничтожает соединение и не убивает сессию', { timeout: 5000 }, async t => {
    const session = createSession(t);

    let destroyCalls = 0;
    session.connection = {
        destroy() {
            destroyCalls += 1;
        }
    };
    session.tracks.push({ url: 'https://example.com/a.mp3', title: 'track' });

    await session.stop();

    assert.equal(destroyCalls, 0);
    assert.equal(session.destroyed, false);
    assert.equal(session.tracks.length, 0);
});

test('stop не отписывает плеер от соединения', { timeout: 5000 }, async t => {
    const session = createSession(t);

    let unsubscribeCalls = 0;
    const subscription = {
        unsubscribe() {
            unsubscribeCalls += 1;
        }
    };
    session.subscription = subscription;

    await session.stop();

    assert.equal(unsubscribeCalls, 0);
    assert.notEqual(session.subscription, null);
    assert.equal(session.subscription, subscription);
});

test('_ensureConnectionReady восстанавливает потерянную подписку плеера', { timeout: 5000 }, async t => {
    const session = createSession(t);

    session.connection = {
        state: { status: VoiceConnectionStatus.Ready },
        subscribe: () => ({ unsubscribe() {} })
    };
    session.subscription = null;

    const ready = await session._ensureConnectionReady();

    assert.equal(ready, true);
    assert.notEqual(session.subscription, null);
});

test('cleanupCurrentFile уничтожает поток ресурса и удаляет файл', { timeout: 5000 }, async t => {
    const session = createSession(t);

    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'capybot-test-cleanup-'));
    const filePath = path.join(tempDir, 'track.opus');
    await fsPromises.writeFile(filePath, 'audio-bytes');

    t.after(() => fsPromises.rm(tempDir, { recursive: true, force: true }));

    session.currentFilePath = filePath;
    const playStream = {
        destroyed: false,
        destroy() {
            this.destroyed = true;
        },
        read() {}
    };
    session.currentResource = { playStream };

    await session.cleanupCurrentFile();

    assert.equal(playStream.destroyed, true);
    assert.equal(session.currentResource, null);
    await assert.rejects(fsPromises.stat(filePath), { code: 'ENOENT' });
});

test('отмена во время создания ресурса не запускает воспроизведение и удаляет файл', { timeout: 5000 }, async t => {
    const session = createSession(t);

    let playCalls = 0;
    session.player.play = () => {
        playCalls += 1;
        return true;
    };
    session._ensureConnectionReady = async () => true;

    let downloadedPath = null;
    const originalDownload = SafeHttpClient.download;
    SafeHttpClient.download = async (url, targetPath) => {
        downloadedPath = targetPath;
        await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
        await fsPromises.writeFile(targetPath, Buffer.from('audio-bytes'));
    };

    const originalCreateFileResource = AudioResourceFactory.createFileResource;
    const createdStreams = [];
    AudioResourceFactory.createFileResource = async () => {
        // skip/stop пришёл, пока читали заголовок файла (окно await).
        session.downloadController?.abort?.();
        const playStream = {
            destroyed: false,
            destroy() {
                this.destroyed = true;
            },
            read() {}
        };
        createdStreams.push(playStream);
        return { playStream };
    };
    t.after(() => {
        SafeHttpClient.download = originalDownload;
        AudioResourceFactory.createFileResource = originalCreateFileResource;
    });

    const track = { url: 'https://example.com/a.mp3', title: 'track', isLive: false, trackDurationMs: null };
    session.tracks.push(track);

    const started = await session._playNextTrackInternal();

    assert.equal(started, false);
    assert.equal(playCalls, 0);
    assert.equal(createdStreams.length, 1);
    assert.equal(createdStreams[0].destroyed, true);
    assert.equal(session.currentFilePath, null);
    assert.ok(downloadedPath);
    await assert.rejects(fsPromises.access(downloadedPath), { code: 'ENOENT' });
});

function stubPlayerForTeardown(session, resource) {
    const fakePlayer = {
        state: { status: AudioPlayerStatus.Playing, resource },
        stopped: undefined,
        stop(called) {
            this.stopped = called;
            this.state = { status: AudioPlayerStatus.Idle };
        }
    };
    session.player = fakePlayer;
    return fakePlayer;
}

test('_watchResourceTeardown переводит плеер в Idle, если поток закрылся раньше плеера', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const resource = { playStream: new EventEmitter() };
    const fakePlayer = stubPlayerForTeardown(session, resource);

    t.mock.timers.enable({ apis: ['setTimeout'] });

    session._watchResourceTeardown(resource);
    resource.playStream.emit('close');
    assert.equal(session.pendingTimers.size, 1);

    t.mock.timers.tick(3000);

    assert.equal(fakePlayer.stopped, true);
    assert.equal(session.player.state.status, AudioPlayerStatus.Idle);
    assert.equal(session.pendingTimers.size, 0);
});

test('_watchResourceTeardown не трогает плеер, который уже в Idle', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const resource = { playStream: new EventEmitter() };
    const fakePlayer = stubPlayerForTeardown(session, resource);
    fakePlayer.state = { status: AudioPlayerStatus.Idle, resource };

    t.mock.timers.enable({ apis: ['setTimeout'] });

    session._watchResourceTeardown(resource);
    resource.playStream.emit('close');
    t.mock.timers.tick(3000);

    assert.equal(fakePlayer.stopped, undefined);
    assert.equal(session.pendingTimers.size, 0);
});

test('_watchResourceTeardown не останавливает плеер с другим ресурсом', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const resource = { playStream: new EventEmitter() };
    const fakePlayer = stubPlayerForTeardown(session, { other: true });

    t.mock.timers.enable({ apis: ['setTimeout'] });

    session._watchResourceTeardown(resource);
    resource.playStream.emit('end');
    t.mock.timers.tick(3000);

    assert.equal(fakePlayer.stopped, undefined);
    assert.equal(session.pendingTimers.size, 0);
});

test('destroy снимает таймер watchdog, поставленный после close потока', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const resource = { playStream: new EventEmitter() };

    t.mock.timers.enable({ apis: ['setTimeout'] });

    session._watchResourceTeardown(resource);
    resource.playStream.emit('close');
    assert.equal(session.pendingTimers.size, 1);

    await session.destroy();

    assert.equal(session.pendingTimers.size, 0);
    t.mock.timers.tick(3000);
    assert.equal(session.pendingTimers.size, 0);
});

function createFakeVoiceConnection() {
    const handlers = new Map();
    const offCalls = [];
    const connection = {
        on(event, handler) {
            handlers.set(event, handler);
            return connection;
        },
        off(event, handler) {
            offCalls.push({ event, handler });
            if (handlers.get(event) === handler) handlers.delete(event);
            return connection;
        },
        subscribe() {
            return { unsubscribe() {} };
        },
        destroy() {}
    };
    return { connection, handlers, offCalls };
}

test('setConnection снимает обработчики со старого соединения при reconnect', { timeout: 5000 }, async t => {
    const session = createSession(t);

    const first = createFakeVoiceConnection();
    const second = createFakeVoiceConnection();

    assert.equal(session.setConnection(first.connection, null), true);
    const firstHandlers = session.connectionHandlers;
    assert.deepEqual([...first.handlers.keys()].sort(), ['debug', 'error', 'stateChange']);

    assert.equal(session.setConnection(second.connection, null), true);

    assert.equal(first.offCalls.length, 3);
    assert.deepEqual(first.offCalls.map(call => call.event).sort(), ['debug', 'error', 'stateChange']);
    for (const call of first.offCalls) {
        assert.equal(call.handler, firstHandlers[call.event === 'stateChange' ? 'onStateChange' : call.event === 'debug' ? 'onDebug' : 'onError']);
    }

    assert.notEqual(session.connectionHandlers, firstHandlers);
    assert.equal(session.connectionHandlers.onStateChange, second.handlers.get('stateChange'));
    assert.equal(session.connectionHandlers.onDebug, second.handlers.get('debug'));
    assert.equal(session.connectionHandlers.onError, second.handlers.get('error'));
    assert.equal(second.offCalls.length, 0);
});

test('_watchResourceTeardown взводит один таймер на close и end', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const resource = { playStream: new EventEmitter() };

    t.mock.timers.enable({ apis: ['setTimeout'] });

    session._watchResourceTeardown(resource);
    resource.playStream.emit('close');
    resource.playStream.emit('end');

    assert.equal(session.pendingTimers.size, 1);
});

test('Destroyed в onStateChange планирует восстановление соединения', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const { connection, handlers } = createFakeVoiceConnection();

    // Клиент выдаёт сессии сам CapyClient.createSession.
    session.client = { getSession: () => session };
    assert.equal(session.setConnection(connection, null), true);

    handlers.get('stateChange')(
        { status: VoiceConnectionStatus.Connecting },
        { status: VoiceConnectionStatus.Destroyed }
    );

    assert.notEqual(session.voiceRecoveryTimer, null);
    assert.equal(session.pendingTimers.has(session.voiceRecoveryTimer), true);
    assert.equal(session.pendingTimers.size, 1);
});

test('повторные Disconnected/Destroyed не создают второй таймер восстановления', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const { connection, handlers } = createFakeVoiceConnection();

    session.client = { getSession: () => session };
    assert.equal(session.setConnection(connection, null), true);

    const onStateChange = handlers.get('stateChange');
    onStateChange({ status: VoiceConnectionStatus.Ready }, { status: VoiceConnectionStatus.Disconnected });
    const recoveryTimer = session.voiceRecoveryTimer;
    assert.notEqual(recoveryTimer, null);

    onStateChange({ status: VoiceConnectionStatus.Disconnected }, { status: VoiceConnectionStatus.Disconnected });
    onStateChange({ status: VoiceConnectionStatus.Disconnected }, { status: VoiceConnectionStatus.Destroyed });

    assert.equal(session.voiceRecoveryTimer, recoveryTimer);
    assert.equal(session.pendingTimers.size, 1);
});

test('destroy снимает таймер восстановления соединения', { timeout: 5000 }, async t => {
    const session = createSession(t);
    const { connection, handlers } = createFakeVoiceConnection();

    session.client = { getSession: () => session };
    assert.equal(session.setConnection(connection, null), true);

    handlers.get('stateChange')(
        { status: VoiceConnectionStatus.Connecting },
        { status: VoiceConnectionStatus.Destroyed }
    );
    assert.equal(session.pendingTimers.size, 1);

    await session.destroy();

    assert.equal(session.pendingTimers.size, 0);
    assert.equal(session.voiceRecoveryTimer, null);
});

test('_scheduleVoiceRecovery переподключается молча после истечения задержки', { timeout: 5000 }, async t => {
    const session = createSession(t);
    session.client = { getSession: () => session };

    const calls = [];
    session.reconnect = async (...args) => {
        calls.push(args);
    };

    session._scheduleVoiceRecovery(10);
    await new Promise(resolve => setTimeout(resolve, 40));

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [session.client, 'guild-1', { silent: true }]);
    assert.equal(session.voiceRecoveryTimer, null);
});

test('_scheduleVoiceRecovery не переподключает живое Ready-соединение', { timeout: 5000 }, async t => {
    const session = createSession(t);
    session.client = { getSession: () => session };
    session.connection = { state: { status: VoiceConnectionStatus.Ready } };

    const calls = [];
    session.reconnect = async (...args) => {
        calls.push(args);
    };

    session._scheduleVoiceRecovery(10);
    await new Promise(resolve => setTimeout(resolve, 40));

    assert.equal(calls.length, 0);
    assert.equal(session.pendingTimers.size, 0);
});

test('stop снимает взведённый таймер восстановления и обнуляет поле', { timeout: 5000 }, async t => {
    const session = createSession(t);
    session.client = { getSession: () => session };

    const calls = [];
    session.reconnect = async (...args) => {
        calls.push(args);
    };

    session._scheduleVoiceRecovery(50);
    assert.notEqual(session.voiceRecoveryTimer, null);

    await session.stop();

    assert.equal(session.voiceRecoveryTimer, null);
    assert.equal(session.pendingTimers.size, 0);

    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(calls.length, 0);
});
