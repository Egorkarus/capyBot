const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Таймаут «без активности» для теста. config читает env при загрузке модуля,
// поэтому переменная выставляется в before ДО require клиента и снимается в after:
// иначе значение протекает в другие тесты в том же процессе.
const TIMEOUT_ENV_NAME = 'YT_DLP_TIMEOUT_MS';
const YT_DLP_CLIENT_PATH = require.resolve('../src/utils/YtDlpClient');
const CONFIG_PATH = require.resolve('../src/config');

// Мок spawn обязан появиться раньше регистрации before: Node 24 выполняет
// top-level before сразу при регистрации, поэтому клиент, загруженный в хуке,
// захватил бы настоящий spawn и попытался запустить отсутствующий yt-dlp.
const originalSpawn = cp.spawn;
let scenario = null;
let lastChild = null;

function createFakeYtDlp(onStarted) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;

    let isClosed = false;
    child.closeWith = (code, signal = null) => {
        if (isClosed) return;
        isClosed = true;
        child.exitCode = code;
        child.signalCode = signal;
        child.stdout.end();
        child.stderr.end();
        child.emit('close', code, signal);
    };
    child.kill = () => setTimeout(() => child.closeWith(null, 'SIGTERM'), 10);

    setTimeout(() => onStarted(child), 20);
    return child;
}

// yt-dlp подменяется полностью: реального бинарника в окружении нет.
cp.spawn = (command, args) => {
    if (command === 'taskkill') {
        // Windows-ветка killProcessTree: убийца просит фейковый yt-dlp закрыться.
        const killer = new EventEmitter();
        setTimeout(() => lastChild?.kill?.(), 10);
        return killer;
    }

    if (command !== 'yt-dlp' || !scenario) return originalSpawn(command, args);

    lastChild = createFakeYtDlp(scenario);
    return lastChild;
};

let YtDlpClient = null;
let savedTimeoutEnv;
let cachedConfigModule = null;

before(() => {
    savedTimeoutEnv = process.env[TIMEOUT_ENV_NAME];
    process.env[TIMEOUT_ENV_NAME] = '120';

    cachedConfigModule = require.cache[CONFIG_PATH];
    delete require.cache[CONFIG_PATH];
    delete require.cache[YT_DLP_CLIENT_PATH];
    YtDlpClient = require(YT_DLP_CLIENT_PATH);
});

after(() => {
    if (savedTimeoutEnv === undefined) {
        delete process.env[TIMEOUT_ENV_NAME];
    } else {
        process.env[TIMEOUT_ENV_NAME] = savedTimeoutEnv;
    }
    delete require.cache[CONFIG_PATH];
    delete require.cache[YT_DLP_CLIENT_PATH];
    if (cachedConfigModule) {
        require.cache[CONFIG_PATH] = cachedConfigModule;
    }
    // Сначала возвращаем настоящий spawn, потом перезагружаем модуль: иначе
    // перекэшированный YtDlpClient останется с моком в require.cache.
    cp.spawn = originalSpawn;
    require(YT_DLP_CLIENT_PATH);
});

async function createTempDir(t) {
    const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'capybot-ytdlp-'));
    t.after(async () => {
        scenario = null;
        lastChild = null;
        await fsPromises.rm(directory, { recursive: true, force: true });
    });
    return directory;
}

test('ненулевой код yt-dlp удаляет частичные и скачанные файлы', { timeout: 5000 }, async t => {
    const directory = await createTempDir(t);
    const outputPattern = path.join(directory, 'track_test.%(ext)s');

    scenario = async (child) => {
        await fsPromises.writeFile(path.join(directory, 'track_test.mp3.part'), 'partial');
        await fsPromises.writeFile(path.join(directory, 'track_test.mp3'), 'done');
        child.closeWith(1);
    };

    await assert.rejects(
        YtDlpClient.downloadFile('https://example.com/a', outputPattern),
        /кодом 1/
    );

    assert.deepEqual(await fsPromises.readdir(directory), []);
});

test('inactivity-таймаут удаляет частичные файлы и логирует фазу', { timeout: 5000 }, async t => {
    const directory = await createTempDir(t);
    const outputPattern = path.join(directory, 'track_test.%(ext)s');

    scenario = async (child) => {
        await fsPromises.writeFile(path.join(directory, 'track_test.mp3.part'), 'partial');
        child.stderr.write('ERROR: fragment 1 not found, trying another\n');
    };

    await assert.rejects(
        YtDlpClient.downloadFile('https://example.com/a', outputPattern),
        error => /без активности/.test(error.message)
            && error.message.includes('ERROR: fragment 1 not found')
    );

    assert.deepEqual(await fsPromises.readdir(directory), []);
});

test('abort удаляет частичные файлы только после закрытия процесса', { timeout: 5000 }, async t => {
    const directory = await createTempDir(t);
    const outputPattern = path.join(directory, 'track_test.%(ext)s');
    const controller = new AbortController();

    scenario = async (child) => {
        await fsPromises.writeFile(path.join(directory, 'track_test.mp3.part'), 'partial');
    };

    const download = YtDlpClient.downloadFile('https://example.com/a', outputPattern, null, {
        signal: controller.signal
    });
    setTimeout(() => controller.abort(), 60);

    await assert.rejects(download, error => error.code === 'ABORTED');
    assert.deepEqual(await fsPromises.readdir(directory), []);
});

test('частичные файлы удаляются только после close процесса с ненулевым кодом', { timeout: 5000 }, async t => {
    const directory = await createTempDir(t);
    const outputPattern = path.join(directory, 'track_order.%(ext)s');
    const modulePath = require.resolve('../src/utils/YtDlpClient');
    const cachedModule = require.cache[modulePath];
    const originalRm = fsPromises.rm;
    const events = [];

    // YtDlpClient деструктурирует fs/promises на уровне модуля, поэтому rm
    // подменяется до повторной загрузки модуля, а не после.
    fsPromises.rm = async (filePath, options) => {
        events.push('rm');
        return originalRm(filePath, options);
    };

    t.after(() => {
        fsPromises.rm = originalRm;
        if (cachedModule) {
            require.cache[modulePath] = cachedModule;
        } else {
            delete require.cache[modulePath];
        }
    });

    delete require.cache[modulePath];
    const InstrumentedYtDlpClient = require('../src/utils/YtDlpClient');
    assert.notEqual(InstrumentedYtDlpClient, YtDlpClient);

    scenario = async (child) => {
        await fsPromises.writeFile(path.join(directory, 'track_order.mp3.part'), 'partial');
        child.on('close', () => events.push('close'));
        // Windows освобождает дескриптор с задержкой после завершения процесса.
        setTimeout(() => child.closeWith(1), 25);
    };

    await assert.rejects(
        InstrumentedYtDlpClient.downloadFile('https://example.com/a', outputPattern),
        /кодом 1/
    );

    assert.deepEqual(events, ['close', 'rm']);
    assert.deepEqual(await fsPromises.readdir(directory), []);
});
