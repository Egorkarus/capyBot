const path = require('path');
const { StreamType } = require('@discordjs/voice');

const OPUS_FILE_EXTENSIONS = new Set(['.opus', '.ogg']);

function isOpusContainer(filePath) {
    if (!filePath) return false;
    return OPUS_FILE_EXTENSIONS.has(path.extname(String(filePath)).toLowerCase());
}

function resolvePlaybackOptions(filePath) {
    return isOpusContainer(filePath) ? { inputType: StreamType.OggOpus } : {};
}

module.exports = { isOpusContainer, resolvePlaybackOptions };
