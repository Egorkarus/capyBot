const { getGuildAudioState, pauseAudio } = require('../audioManager');
const { logInfo } = require('../logger');

module.exports = {
    name: 'pause',
    adminOnly: false,
    async execute(message) {
        const audioState = getGuildAudioState(message.guild.id);
        if (!audioState || audioState.player.state.status === 'idle') {
            await message.reply("А на паузу-то ставить нечего, тишина вокруг. 🍊");
            return;
        }

        pauseAudio(message.guild.id);
        logInfo(`Paused audio playback in guild ${message.guild.id}`);
        await message.reply("Поставил на паузу. Жду твоего приказа, хозяин. 🍊⏸️");
    }
};
