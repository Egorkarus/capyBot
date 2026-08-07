const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const { logError, logInfo } = require('../utils/logger');
const GuildSession = require('../structures/GuildSession');

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
        const isTwitchUrl = fileUrl && fileUrl.includes('twitch.tv');
        
        let isAudioOrVideoUrl = false;
        if (fileUrl) {
            try {
                const parsedUrl = new URL(fileUrl);
                const ext = parsedUrl.pathname.toLowerCase();
                isAudioOrVideoUrl = ext.endsWith('.mp3') || ext.endsWith('.mp4') || ext.endsWith('.wav') || ext.endsWith('.ogg') || ext.endsWith('.m4a') || ext.endsWith('.flac');
            } catch (err) {
                const cleanUrl = fileUrl.toLowerCase().split('?')[0];
                isAudioOrVideoUrl = cleanUrl.endsWith('.mp3') || cleanUrl.endsWith('.mp4') || cleanUrl.endsWith('.wav') || cleanUrl.endsWith('.ogg');
            }
        }

        if (!fileUrl || (!isAudioOrVideoUrl && !isYoutubeUrl && !isSoundcloudUrl && !isTwitchUrl)) {
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
