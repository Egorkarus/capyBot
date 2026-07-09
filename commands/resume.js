const { getGuildAudioState, resumeAudio } = require('../audioManager');
const { logInfo } = require('../logger');

module.exports = {
    name: 'resume',
    adminOnly: false,
    async execute(message) {
        const audioState = getGuildAudioState(message.guild.id);
        if (!audioState || audioState.player.state.status !== 'paused') {
            await message.reply("Шарманка и так крутится (или вообще выключена). 🍊");
            return;
        }

        resumeAudio(message.guild.id);
        logInfo(`Resumed audio playback in guild ${message.guild.id}`);
        await message.reply("Снял с паузы. Продолжаем веселье! 🍊▶️");
    }
};
