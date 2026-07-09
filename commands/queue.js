const { getGuildAudioState } = require('../audioManager');

module.exports = {
    name: 'queue',
    adminOnly: false,
    async execute(message) {
        const audioState = getGuildAudioState(message.guild.id);
        if (!audioState || audioState.tracks.length === 0) {
            await message.reply("В очереди пусто, как в моей голове после обеда. 🍊");
            return;
        }

        const trackList = audioState.tracks
            .slice(0, 10)
            .map((track, index) => `${index + 1}. **${track.title}**`)
            .join('\n');

        const remainingCount = audioState.tracks.length - 10;
        const extraText = remainingCount > 0 ? `\n...и еще ${remainingCount} треков.` : '';

        await message.reply(`**Очередь треков:**\n${trackList}${extraText}`);
    }
};
