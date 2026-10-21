const fsPromises = require('fs/promises');

const OGG_CAPTURE_PATTERN = Buffer.from('OggS');
const OGG_PAGE_HEADER_BYTES = 27;
const OGG_PAGE_SEGMENTS_OFFSET = 26;
const OPUS_HEAD_SIGNATURE = Buffer.from('OpusHead');
const OPUS_HEAD_VERSION_BYTES = 1;
const OPUS_HEAD_PROBE_BYTES = 8192;

/**
 * Ищет OpusHead на границе пакета Ogg-страницы: заголовок 27 байт плюс
 * таблица сегментов. Возвращает channel count или null.
 */
function readOpusHeadChannels(buffer, bytesRead) {
    const probe = buffer.subarray(0, bytesRead);
    let searchFrom = 0;

    while (searchFrom < bytesRead) {
        const pageOffset = probe.indexOf(OGG_CAPTURE_PATTERN, searchFrom);
        if (pageOffset === -1) return null;
        if (pageOffset + OGG_PAGE_HEADER_BYTES > bytesRead) return null;

        const segmentCount = buffer[pageOffset + OGG_PAGE_SEGMENTS_OFFSET];
        const payloadOffset = pageOffset + OGG_PAGE_HEADER_BYTES + segmentCount;
        const signatureEnd = payloadOffset + OPUS_HEAD_SIGNATURE.length;
        if (signatureEnd > bytesRead) return null;

        if (buffer.subarray(payloadOffset, signatureEnd).equals(OPUS_HEAD_SIGNATURE)) {
            const channelsOffset = signatureEnd + OPUS_HEAD_VERSION_BYTES;
            if (channelsOffset >= bytesRead) return null;
            return buffer[channelsOffset];
        }

        searchFrom = pageOffset + OGG_CAPTURE_PATTERN.length;
    }

    return null;
}

/**
 * Возвращает число каналов из заголовка OpusHead или null, если файл не Ogg/Opus.
 */
async function readOpusChannels(filePath) {
    let handle = null;
    try {
        handle = await fsPromises.open(filePath, 'r');
        const buffer = Buffer.alloc(OPUS_HEAD_PROBE_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, OPUS_HEAD_PROBE_BYTES, 0);
        return readOpusHeadChannels(buffer, bytesRead);
    } catch (error) {
        return null;
    } finally {
        if (handle) await handle.close().catch(() => {});
    }
}

module.exports = { readOpusChannels };
