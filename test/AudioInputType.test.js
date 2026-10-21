const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');

const { readOpusChannels } = require('../src/utils/AudioInputType');

const OPUS_HEAD_BYTES = Buffer.from('OpusHead');

async function withTempFile(t, fileName, contents) {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'capybot-audio-'));
    t.after(() => fsPromises.rm(tempDir, { recursive: true, force: true }));

    const filePath = path.join(tempDir, fileName);
    await fsPromises.writeFile(filePath, contents);
    return filePath;
}

test('readOpusChannels читает stereo из заголовка OpusHead', async (t) => {
    const filePath = await withTempFile(
        t,
        'stereo.opus',
        Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('OggS'), OPUS_HEAD_BYTES, Buffer.from([1, 2])])
    );

    assert.equal(await readOpusChannels(filePath), 2);
});

test('readOpusChannels читает mono из заголовка OpusHead', async (t) => {
    const filePath = await withTempFile(
        t,
        'mono.opus',
        Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('OggS'), OPUS_HEAD_BYTES, Buffer.from([1, 1])])
    );

    assert.equal(await readOpusChannels(filePath), 1);
});

test('readOpusChannels игнорирует OpusHead без Ogg-страницы перед ним', async (t) => {
    const filePath = await withTempFile(t, 'fake-opus.ogg', Buffer.from('xxxxOpusHead'));

    assert.equal(await readOpusChannels(filePath), null);
});

test('readOpusChannels возвращает null, если channel count за концом окна чтения', async (t) => {
    const filePath = await withTempFile(
        t,
        'truncated.opus',
        Buffer.concat([Buffer.from('OggS'), OPUS_HEAD_BYTES])
    );

    assert.equal(await readOpusChannels(filePath), null);
});

test('readOpusChannels возвращает null без сигнатуры OpusHead', async (t) => {
    const filePath = await withTempFile(t, 'not-opus.bin', Buffer.from('JVBERi0='));

    assert.equal(await readOpusChannels(filePath), null);
});

test('readOpusChannels возвращает null для пустого файла', async (t) => {
    const filePath = await withTempFile(t, 'empty.opus', Buffer.alloc(0));

    assert.equal(await readOpusChannels(filePath), null);
});

test('readOpusChannels возвращает null для несуществующего пути', async () => {
    const missingPath = path.join(os.tmpdir(), `capybot-missing-${process.pid}-${Date.now()}.opus`);

    assert.equal(await readOpusChannels(missingPath), null);
});
