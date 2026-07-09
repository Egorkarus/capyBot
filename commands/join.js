const { joinVoiceChannel, getVoiceConnection, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const { getVoiceState, setVoiceState } = require('../voiceManager');
const { logError, logInfo } = require('../logger');

module.exports = {
    name: 'join',
    adminOnly: true,
    async execute(message) {
        const voiceChannel = message.member?.voice.channel;
        if (!voiceChannel) {
            await message.reply("Э, дорогуша, сначала сам заползи в голосовой канал, потом меня зови. 🐾");
            return;
        }

        const currentState = getVoiceState(message.guild.id);
        if (currentState && currentState.voiceChannelId === voiceChannel.id) {
            await message.reply("Глаза разуй, я уже сижу тут и чиллю. 🍊");
            return;
        }

        const existingConnection = getVoiceConnection(message.guild.id);
        if (existingConnection) {
            existingConnection.destroy();
        }

        try {
            const newConnection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: true
            });

            await entersState(newConnection, VoiceConnectionStatus.Ready, 5000);

            setVoiceState(message.guild.id, voiceChannel.id, message.channel.id);
            logInfo(`Joined voice channel ${voiceChannel.id} in guild ${message.guild.id}`);

            await message.reply("Притопал. Всем оставаться на своих местах, капибара в здании. 🍊👑");
        } catch (error) {
            logError("Failed to join voice channel", error);
            await message.reply("Чё-то не пускает твоя калитка в канал. Попробуй позже, я пока полежу. 🛌");
        }
    }
};
