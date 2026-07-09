const { getVoiceConnection } = require('@discordjs/voice');
const { removeVoiceState } = require('../voiceManager');
const { logInfo } = require('../logger');

module.exports = {
    name: 'leave',
    adminOnly: true,
    async execute(message) {
        const connection = getVoiceConnection(message.guild.id);
        if (!connection) {
            await message.reply("Я и так не с вами, гений. Чиллю на суше. 🏝️");
            return;
        }

        removeVoiceState(message.guild.id);
        connection.destroy();
        logInfo(`Left voice channel in guild ${message.guild.id}`);

        await message.reply("Всё, мне надоело ваше общество, пошёл принимать ванну с апельсинами. Пока. 🍊🌊");
    }
};
