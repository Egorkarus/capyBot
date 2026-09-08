const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const { logError, logInfo } = require('../utils/logger');
const GuildSession = require('../structures/GuildSession');
const TrackSourceValidator = require('../utils/TrackSourceValidator');

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

        const rateLimitCheck = client.rateLimiter.checkUserLimit(message.author.id);
        if (!rateLimitCheck.allowed) {
            await message.reply(rateLimitCheck.reason);
            return;
        }

        const attachment = message.attachments.first();
        let validation;
        let normalizedSource;

        if (attachment) {
            validation = TrackSourceValidator.validateAttachment(attachment);
            if (!validation.valid) {
                await message.reply(`❌ ${validation.reason}`);
                return;
            }
            normalizedSource = validation.normalized;
        } else {
            const fileUrl = args[0];
            if (!fileUrl) {
                await message.reply(client.config.messages.playInvalidUrl);
                return;
            }

            validation = TrackSourceValidator.validate(fileUrl);
            if (!validation.valid) {
                await message.reply(`❌ ${validation.reason}`);
                return;
            }
            normalizedSource = validation.normalized;
        }

        let session = client.getSession(message.guild.id);
        
        const queueLimitCheck = client.rateLimiter.checkQueueLimit(message.guild.id, message.author.id, session);
        if (!queueLimitCheck.allowed) {
            await message.reply(queueLimitCheck.reason);
            return;
        }
        
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
            const trackUrl = normalizedSource.url.href;
            const title = await GuildSession.fetchTrackTitle(trackUrl);
            const isIdle = session.player.state.status === 'idle';
            
            session.addTrack(trackUrl, title, message.channel, message.author.id);

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
