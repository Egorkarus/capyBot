const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const { logError, logInfo } = require('../logger');

module.exports = {
    name: 'join',
    adminOnly: true,
    async execute(message) {
        const client = message.client;
        const voiceChannel = message.member?.voice.channel;
        
        if (!voiceChannel) {
            await message.reply(client.config.messages.notInVoice);
            return;
        }

        let session = client.getSession(message.guild.id);
        if (session && session.voiceChannelId === voiceChannel.id) {
            await message.reply(client.config.messages.alreadyInVoice);
            return;
        }

        if (session) {
            session.destroy();
        }

        session = client.createSession(message.guild.id, voiceChannel.id, message.channel.id);

        try {
            const newConnection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: true
            });

            await entersState(newConnection, VoiceConnectionStatus.Ready, client.config.timeouts.joinReady);
            session.setConnection(newConnection, message.channel);
            
            logInfo(`Joined voice channel ${voiceChannel.id}`);
            await message.reply(client.config.messages.joinSuccess);
        } catch (error) {
            logError("Failed to join voice channel", error);
            client.deleteSession(message.guild.id);
            await message.reply(client.config.messages.joinFail);
        }
    }
};
