const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');

const SafeHttpClient = require('../src/utils/SafeHttpClient');

let fileCounter = 0;
const createdFiles = [];

function createTempPath(label) {
    fileCounter += 1;
    const filePath = path.join(os.tmpdir(), `capybot-test-${process.pid}-${fileCounter}-${label}`);
    createdFiles.push(filePath);
    return filePath;
}

function assertFileRemoved(filePath) {
    // Контракт writeResponseToFile: reject наступает только после удаления файла.
    assert.equal(fs.existsSync(filePath), false, `Файл не был удалён: ${filePath}`);
}

after(async () => {
    await Promise.all(createdFiles.map(filePath =>
        fsPromises.rm(filePath, { force: true }).catch(() => {})
    ));
});

test('writeResponseToFile записывает поток в файл', { timeout: 5000 }, async () => {
    const outputPath = createTempPath('success.mp3');

    await SafeHttpClient.writeResponseToFile(
        Readable.from([Buffer.from('abc')]),
        outputPath,
        { maxBytes: 1024 }
    );

    const contents = await fsPromises.readFile(outputPath, 'utf8');
    assert.equal(contents, 'abc');
});

test('writeResponseToFile отклоняет поток больше лимита и удаляет файл', { timeout: 5000 }, async () => {
    const outputPath = createTempPath('oversize.mp3');
    const source = Readable.from([Buffer.alloc(4096)]);

    await assert.rejects(
        SafeHttpClient.writeResponseToFile(source, outputPath, { maxBytes: 1024 }),
        /превышает лимит/
    );

    assertFileRemoved(outputPath);
});

test('writeResponseToFile отклоняет обрыв потока и удаляет файл', { timeout: 5000 }, async () => {
    const outputPath = createTempPath('aborted-stream.mp3');
    const source = new PassThrough();
    const promise = SafeHttpClient.writeResponseToFile(source, outputPath, { maxBytes: 1024 });

    source.write(Buffer.from('partial'));
    source.destroy(new Error('socket hang up'));

    await assert.rejects(promise, /socket hang up/);
    assertFileRemoved(outputPath);
});

test('writeResponseToFile отклоняет close без end и удаляет файл', { timeout: 5000 }, async () => {
    const outputPath = createTempPath('closed-stream.mp3');
    const source = new PassThrough();
    const promise = SafeHttpClient.writeResponseToFile(source, outputPath, { maxBytes: 1024 });

    source.write(Buffer.from('partial'));
    source.destroy();

    await assert.rejects(promise, /Соединение закрыто до завершения загрузки/);
    assertFileRemoved(outputPath);
});

test('writeResponseToFile с уже отменённым signal отклоняет с кодом ABORTED', { timeout: 5000 }, async () => {
    const outputPath = createTempPath('abort-before.mp3');
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        SafeHttpClient.writeResponseToFile(
            Readable.from([Buffer.from('abc')]),
            outputPath,
            { maxBytes: 1024, signal: controller.signal }
        ),
        error => error.code === 'ABORTED'
    );

    assertFileRemoved(outputPath);
});

test('writeResponseToFile прерывается по signal во время записи и удаляет файл', { timeout: 5000 }, async () => {
    const outputPath = createTempPath('abort-during.mp3');
    const source = new PassThrough();
    const controller = new AbortController();
    const promise = SafeHttpClient.writeResponseToFile(source, outputPath, {
        maxBytes: 1024,
        signal: controller.signal
    });

    source.write(Buffer.from('partial'));
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();

    try {
        await assert.rejects(promise, error => error.code === 'ABORTED');
    } finally {
        source.destroy();
    }

    assertFileRemoved(outputPath);
});

test('fetch сравнивает Content-Type целиком и игнорирует параметры', { timeout: 5000 }, async t => {
    const http = require('node:http');
    let contentType = 'audio/mpeg4';

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end('abc');
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const originalResolve = SafeHttpClient.resolveAndValidate;
    SafeHttpClient.resolveAndValidate = async () => '127.0.0.1';

    t.after(async () => {
        SafeHttpClient.resolveAndValidate = originalResolve;
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });

    const url = `http://127.0.0.1:${server.address().port}/file`;

    await assert.rejects(SafeHttpClient.fetch(url), /Недопустимый Content-Type/);

    contentType = 'audio/mpeg; charset=binary';
    const response = await SafeHttpClient.fetch(url);
    response.destroy();
});

test('isIpAddressBlocked помечает приватные, loopback и reserved адреса', { timeout: 5000 }, async () => {
    const blockedAddresses = ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.1.1', '::1'];

    for (const address of blockedAddresses) {
        assert.equal(await SafeHttpClient.isIpAddressBlocked(address), true, address);
    }

    assert.equal(await SafeHttpClient.isIpAddressBlocked('8.8.8.8'), false);
});
