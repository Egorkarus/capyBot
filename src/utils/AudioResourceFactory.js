const fs = require('fs');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const { readOpusChannels } = require('./AudioInputType');
const { logError } = require('./logger');

/**
 * Discord-пайплайн OggOpus рассчитан на stereo 48k, поэтому без ffmpeg играем
 * только ogg/opus с ровно двумя каналами. Остальное отдаём прежним путём.
 */
async function createFileResource(filePath, deps = {}) {
    const readChannels = deps.readChannels ?? readOpusChannels;
    const createResource = deps.createResource ?? createAudioResource;
    const createStream = deps.createStream ?? (target => fs.createReadStream(target));

    const channels = await readChannels(filePath);
    if (channels !== 2) {
        return createResource(filePath);
    }

    const stream = createStream(filePath);
    stream.on('error', error => logError(`Audio file stream failed: ${filePath}`, error));
    return createResource(stream, { inputType: StreamType.OggOpus });
}

module.exports = { createFileResource };
