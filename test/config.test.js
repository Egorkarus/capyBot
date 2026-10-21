const { test } = require('node:test');
const assert = require('node:assert/strict');

const CONFIG_PATH = require.resolve('../src/config');
const MANAGED_ENV_KEYS = [
    'MAX_TRACK_DURATION_SECONDS',
    'MAX_DOWNLOAD_BYTES',
    'MAX_FILE_SIZE_BYTES',
    'PLAY_RATE_LIMIT_WINDOW_MS'
];

function snapshotEnv() {
    const snapshot = new Map();
    for (const key of MANAGED_ENV_KEYS) {
        snapshot.set(key, process.env[key]);
    }
    return snapshot;
}

function restoreEnv(snapshot) {
    for (const [key, value] of snapshot) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    delete require.cache[CONFIG_PATH];
}

function loadConfig(overrides = {}) {
    for (const key of MANAGED_ENV_KEYS) {
        delete process.env[key];
    }
    Object.assign(process.env, overrides);
    delete require.cache[CONFIG_PATH];
    return require(CONFIG_PATH);
}

test('дефолтные лимиты: 1800 с и 70 МБ, размер файла наследует лимит загрузки', t => {
    const envSnapshot = snapshotEnv();
    t.after(() => restoreEnv(envSnapshot));

    const config = loadConfig();

    assert.equal(config.limits.maxTrackDurationSeconds, 1800);
    assert.equal(config.limits.maxDownloadBytes, 70 * 1024 * 1024);
    assert.equal(config.security.maxFileSizeBytes, config.limits.maxDownloadBytes);
    assert.equal(config.limits.playRateLimitWindowMs, 60000);
});

test('переменные окружения переопределяют лимиты', t => {
    const envSnapshot = snapshotEnv();
    t.after(() => restoreEnv(envSnapshot));

    const config = loadConfig({
        MAX_TRACK_DURATION_SECONDS: '60',
        MAX_DOWNLOAD_BYTES: '1000',
        PLAY_RATE_LIMIT_WINDOW_MS: '5000'
    });

    assert.equal(config.limits.maxTrackDurationSeconds, 60);
    assert.equal(config.limits.maxDownloadBytes, 1000);
    assert.equal(config.limits.playRateLimitWindowMs, 5000);
    assert.equal(config.security.maxFileSizeBytes, 1000);
});

test('невалидные значения откатываются к дефолтам', t => {
    const envSnapshot = snapshotEnv();
    t.after(() => restoreEnv(envSnapshot));

    for (const invalidValue of ['abc', '-5', '0']) {
        const config = loadConfig({
            MAX_TRACK_DURATION_SECONDS: invalidValue,
            MAX_DOWNLOAD_BYTES: invalidValue,
            PLAY_RATE_LIMIT_WINDOW_MS: invalidValue
        });

        assert.equal(config.limits.maxTrackDurationSeconds, 1800, `значение ${invalidValue} для длительности`);
        assert.equal(config.limits.maxDownloadBytes, 70 * 1024 * 1024, `значение ${invalidValue} для размера`);
        assert.equal(config.limits.playRateLimitWindowMs, 60000, `значение ${invalidValue} для окна rate limit`);
        assert.equal(config.security.maxFileSizeBytes, config.limits.maxDownloadBytes);
    }
});

test('MAX_FILE_SIZE_BYTES переопределяет только security.maxFileSizeBytes', t => {
    const envSnapshot = snapshotEnv();
    t.after(() => restoreEnv(envSnapshot));

    const config = loadConfig({ MAX_FILE_SIZE_BYTES: '5000' });

    assert.equal(config.security.maxFileSizeBytes, 5000);
    assert.equal(config.limits.maxDownloadBytes, 70 * 1024 * 1024);
});
