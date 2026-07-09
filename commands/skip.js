const { skipAudio } = require('../audioManager');
const { logInfo } = require('../logger');

module.exports = {
    name: 'skip',
    adminOnly: false,
    async execute(message) {
        skipAudio(message.guild.id);
        logInfo(`Skipped current track in guild ${message.guild.id}`);
        await message.reply("Скипнул трек. Несите следующий, этот мне надоел. 🍊⏭️");
    }
};
