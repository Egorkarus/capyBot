const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');

const { readOpusChannels } = require('../src/utils/AudioInputType');

const OGG_PAGE_HEADER_BYTES = 27;
const OGG_PAGE_SEGMENTS_OFFSET = 26;

function buildOpusPage(channels) {
    const opusHead = Buffer.alloc(19);
    opusHead.write('OpusHead', 0, 'ascii');
    opusHead[8] = 1;          // OpusHead version
    opusHead[9] = channels;   // channel count

    const header = Buffer.alloc(OGG_PAGE_HEADER_BYTES);
    header.write('OggS', 0, 'ascii');
    header[4] = 0;            // stream structure version
    header[5] = 2;            // header type: beginning of stream
    header[OGG_PAGE_SEGMENTS_OFFSET] = 1;  // page_segments

    const lacing = Buffer.from([opusHead.length]);  // одна страница на пакет
    return Buffer.concat([header, lacing, opusHead]);
}

function buildVorbisPage(comment) {
    const payload = Buffer.from('\x01vorbis' + comment);
    const header = Buffer.alloc(OGG_PAGE_HEADER_BYTES);
    header.write('OggS', 0, 'ascii');
    header[4] = 0;            // stream structure version
    header[5] = 2;            // header type: beginning of stream
    header[OGG_PAGE_SEGMENTS_OFFSET] = 1;  // page_segments

    return Buffer.concat([header, Buffer.from([payload.length]), payload]);
}

async function withTempFile(t, fileName, contents) {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'capybot-audio-'));
    t.after(() => fsPromises.rm(tempDir, { recursive: true, force: true }));

    const filePath = path.join(tempDir, fileName);
    await fsPromises.writeFile(filePath, contents);
    return filePath;
}

test('readOpusChannels читает stereo из заголовка OpusHead', async (t) => {
    const filePath = await withTempFile(t, 'stereo.opus', buildOpusPage(2));

    assert.equal(await readOpusChannels(filePath), 2);
});

test('readOpusChannels читает mono из заголовка OpusHead', async (t) => {
    const filePath = await withTempFile(t, 'mono.opus', buildOpusPage(1));

    assert.equal(await readOpusChannels(filePath), 1);
});

test('readOpusChannels читает stereo из нескольких Ogg-страниц', async (t) => {
    const filePath = await withTempFile(
        t,
        'two-pages.opus',
        Buffer.concat([buildOpusPage(2), buildOpusPage(2)])
    );

    assert.equal(await readOpusChannels(filePath), 2);
});

test('readOpusChannels переходит к следующей странице, если первая не Opus', async (t) => {
    const filePath = await withTempFile(
        t,
        'vorbis-then-opus.opus',
        Buffer.concat([buildVorbisPage(' comment'), buildOpusPage(2)])
    );

    assert.equal(await readOpusChannels(filePath), 2);
});

test('readOpusChannels игнорирует текст OpusHead в комментарии Vorbis-страницы', async (t) => {
    const filePath = await withTempFile(
        t,
        'vorbis.ogg',
        buildVorbisPage(' comment mentions OpusHead inside the tag text')
    );

    assert.equal(await readOpusChannels(filePath), null);
});

test('readOpusChannels игнорирует OpusHead без Ogg-страницы перед ним', async (t) => {
    const filePath = await withTempFile(t, 'fake-opus.ogg', Buffer.from('xxxxOpusHead'));

    assert.equal(await readOpusChannels(filePath), null);
});

test('readOpusChannels возвращает null, если payload обрезан границей окна чтения', async (t) => {
    const filePath = await withTempFile(t, 'truncated.opus', buildOpusPage(2).subarray(0, 30));

    assert.equal(await readOpusChannels(filePath), null);
});

test('readOpusChannels возвращает null для мусора без Ogg-страницы', async (t) => {
    const filePath = await withTempFile(t, 'not-opus.bin', Buffer.from('not an ogg file at all'));

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
