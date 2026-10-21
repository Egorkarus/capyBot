const fsPromises = require('fs/promises');

const OPUS_HEAD_SIGNATURE = Buffer.from('OpusHead');
const OGG_PAGE_CAPTURE_PATTERN = Buffer.from('OggS');
const OPUS_HEAD_PROBE_BYTES = 8192;

/**
 * Возвращает число каналов из заголовка OpusHead или null, если файл не Ogg/Opus.
 * Байт после сигнатуры "OpusHead" + версия — это channel count.
 */
async function readOpusChannels(filePath) {
    let handle = null;
    try {
        handle = await fsPromises.open(filePath, 'r');
        const buffer = Buffer.alloc(OPUS_HEAD_PROBE_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, OPUS_HEAD_PROBE_BYTES, 0);
        const signatureIndex = buffer.subarray(0, bytesRead).indexOf(OPUS_HEAD_SIGNATURE);
        if (signatureIndex === -1) return null;

        // Сигнатура OpusHead обязана идти сразу за capture pattern Ogg-страницы:
        // иначе это может быть текст в теге Vorbis-файла, а не Opus-контейнер.
        const pageStart = signatureIndex - 4;
        if (pageStart < 0) return null;
        const isOggPage = buffer.subarray(pageStart, pageStart + 4).equals(OGG_PAGE_CAPTURE_PATTERN);
        if (!isOggPage) return null;

        const channelsOffset = signatureIndex + OPUS_HEAD_SIGNATURE.length + 1;
        if (channelsOffset >= bytesRead) return null;
        return buffer.readUInt8(channelsOffset);
    } catch (error) {
        return null;
    } finally {
        if (handle) await handle.close().catch(() => {});
    }
}

module.exports = { readOpusChannels };
