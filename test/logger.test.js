const { test } = require('node:test');
const assert = require('node:assert/strict');

const LOGGER_PATH = require.resolve('../src/utils/logger');
const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error
};

function useLogger(t, logLevel) {
    const previousLevel = process.env.LOG_LEVEL;
    const calls = [];

    if (logLevel === undefined) {
        delete process.env.LOG_LEVEL;
    } else {
        process.env.LOG_LEVEL = logLevel;
    }

    console.log = message => calls.push({ method: 'log', text: String(message) });
    console.warn = message => calls.push({ method: 'warn', text: String(message) });
    console.error = (message, error) => calls.push({ method: 'error', text: String(message), error });

    delete require.cache[LOGGER_PATH];
    const logger = require(LOGGER_PATH);

    t.after(() => {
        console.log = originalConsole.log;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;

        if (previousLevel === undefined) {
            delete process.env.LOG_LEVEL;
        } else {
            process.env.LOG_LEVEL = previousLevel;
        }
        delete require.cache[LOGGER_PATH];
    });

    return { logger, calls };
}

test('LOG_LEVEL=error: info/warn/debug молчат, error пишет в console.error', t => {
    const { logger, calls } = useLogger(t, 'error');

    logger.logInfo('info-message');
    logger.logWarn('warn-message');
    logger.logDebug('debug-message');
    logger.logError('error-message');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'error');
    assert.match(calls[0].text, /\[ERROR\] error-message/);
});

test('по умолчанию уровень info: logInfo пишет, logDebug молчит', t => {
    const { logger, calls } = useLogger(t, undefined);

    logger.logInfo('info-message');
    logger.logDebug('debug-message');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'log');
    assert.match(calls[0].text, /\[INFO\] info-message/);
});

test('LOG_LEVEL=debug: logDebug пишет', t => {
    const { logger, calls } = useLogger(t, 'debug');

    logger.logDebug('debug-message');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'log');
    assert.match(calls[0].text, /\[DEBUG\] debug-message/);
});

test('невалидный уровень ведёт себя как info', t => {
    const { logger, calls } = useLogger(t, 'verbose');

    logger.logDebug('debug-message');
    logger.logInfo('info-message');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'log');
    assert.match(calls[0].text, /\[INFO\] info-message/);
});

test('logError с объектом ошибки передаёт его в console.error', t => {
    const { logger, calls } = useLogger(t, 'error');
    const failure = new Error('boom');

    logger.logError('failure', failure);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].error, failure);
});
