const fs = require('fs');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const { readOpusChannels } = require('./AudioInputType');
const { logDebug, logError } = require('./logger');

function logStreamFailure(filePath, error, loggers = {}) {
    const debug = loggers.logDebug ?? logDebug;
    const errorLog = loggers.logError ?? logError;

    // Штатный teardown (skip/stop/конец трека) разрушает поток раньше пайплайна:
    // это не ошибка чтения файла, в ERROR-лог такое писать нельзя.
    if (error && error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        debug(`Audio stream closed early (teardown): ${filePath}`);
        return;
    }

    errorLog(`Audio file stream failed: ${filePath}`, error);
}

/**
 * Discord-пайплайн OggOpus рассчитан на stereo 48k, поэтому без ffmpeg играем
 * только ogg/opus с ровно двумя каналами. Остальное отдаём прежним путём.
 */
async function createFileResource(filePath, deps = {}) {
    const readChannels = deps.readChannels ?? readOpusChannels;
    const createResource = deps.createResource ?? createAudioResource;
    const createStream = deps.createStream ?? (target => fs.createReadStream(target));
    const onFailure = deps.logStreamFailure ?? logStreamFailure;

    const channels = await readChannels(filePath);
    if (channels !== 2) {
        return createResource(filePath);
    }

    const stream = createStream(filePath);
    // Обработчик обязателен: unhandled 'error' на потоке уронит процесс.
    stream.on('error', error => onFailure(filePath, error, deps.loggers));
    return createResource(stream, { inputType: StreamType.OggOpus });
}

module.exports = { createFileResource, logStreamFailure };
