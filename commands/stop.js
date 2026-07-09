const { stopAudio } = require('../audioManager');
const { logInfo } = require('../logger');

module.exports = {
    name: 'stop',
    adminOnly: true,
    async execute(message) {
        stopAudio(message.guild.id);
        logInfo(`Stopped playback and cleared queue via admin in guild ${message.guild.id}`);
        await message.reply("Полная остановка! Очередь очищена, бот отдыхает. 👑🍊🛑");
    }
};
