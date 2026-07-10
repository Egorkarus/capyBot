const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const { logError, logInfo } = require('../logger');
const GuildSession = require('../GuildSession');

module.exports = {
    name: 'play',
    adminOnly: false,
    async execute(message, args) {
        const client = message.client;
        const voiceChannel = message.member?.voice.channel;
        
        if (!voiceChannel) {
            await message.reply(client.config.messages.notInVoice);
            return;
        }

        const attachment = message.attachments.first();
        const fileUrl = attachment ? attachment.url : args[0];
        
        const isYoutubeUrl = fileUrl && (fileUrl.includes('youtube.com') || fileUrl.includes('youtu.be'));
        const isSoundcloudUrl = fileUrl && fileUrl.includes('soundcloud.com');
        
        let isMp3Url = false;
        if (fileUrl) {
            try {
                const parsedUrl = new URL(fileUrl);
                isMp3Url = parsedUrl.pathname.toLowerCase().endsWith('.mp3');
            } catch (err) {
                isMp3Url = fileUrl.toLowerCase().split('?')[0].endsWith('.mp3');
            }
        }

        if (!fileUrl || (!isMp3Url && !isYoutubeUrl && !isSoundcloudUrl)) {
            await message.reply(client.config.messages.playInvalidUrl);
            return;
        }

        let session = client.getSession(message.guild.id);
        
        if (!session) {
            session = client.createSession(message.guild.id, voiceChannel.id, message.channel.id);
            try {
                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: voiceChannel.guild.id,
                    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                    selfDeaf: true
                });
                
                await entersState(connection, VoiceConnectionStatus.Ready, client.config.timeouts.joinReady);
                session.setConnection(connection, message.channel);
                logInfo(`Joined voice channel ${voiceChannel.id} on play`);
            } catch (error) {
                logError("Failed to join voice channel on play", error);
                client.deleteSession(message.guild.id);
                await message.reply(client.config.messages.joinFail);
                return;
            }
        }

        const statusMessage = await message.reply(client.config.messages.playFetching);

        try {
            const title = await GuildSession.fetchTrackTitle(fileUrl);
            const isIdle = session.player.state.status === 'idle';
            
            session.addTrack(fileUrl, title);

            if (isIdle) {
                await statusMessage.edit(client.config.messages.playNowPlaying.replace('{title}', title));
            } else {
                await statusMessage.edit(client.config.messages.playQueued.replace('{title}', title));
            }
        } catch (playError) {
            logError("Error fetching metadata or playing audio", playError);
            await statusMessage.edit(client.config.messages.playError);
        }
    }
};
