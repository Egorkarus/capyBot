const { joinVoiceChannel, entersState, VoiceConnectionStatus, AudioPlayerStatus } = require('@discordjs/voice');
const { logError, logInfo, logWarn } = require('../utils/logger');
const GuildSession = require('../structures/GuildSession');
const PlatformSource = require('../utils/PlatformSource');
const TrackSourceValidator = require('../utils/TrackSourceValidator');

// Соединение, созданное командой play, нужно уничтожать на всех ветках выхода:
// иначе бот остаётся в голосовом канале без живой сессии.
const destroyVoiceConnection = connection => {
    if (!connection) return;
    try {
        connection.destroy();
    } catch (error) {
        logWarn('Failed to destroy voice connection on play', error);
    }
};

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

        const trackUrl = normalizedSource.url.href;
        const isPlatform = PlatformSource.isPlatformUrl(trackUrl);

        let session = client.getSession(message.guild.id);
        
        const queueLimitCheck = client.rateLimiter.checkQueueLimit(message.guild.id, message.author.id, session);
        if (!queueLimitCheck.allowed) {
            await message.reply(queueLimitCheck.reason);
            return;
        }

        const statusMessage = await message.reply(client.config.messages.playFetching);

        // Метаданные и подключение к каналу не зависят друг от друга — запускаем параллельно.
        // Rejection сразу превращается в значение, чтобы промис не остался без обработчика,
        // даже если join упадёт и мы выйдем раньше.
        const trackInfoPromise = GuildSession.fetchTrackInfo(trackUrl).then(
            value => ({ ok: true, value }),
            error => ({ ok: false, error })
        );

        let createdSession = false;
        // Соединение, созданное этим вызовом, держим отдельно: его надо уничтожать
        // на любой ветке выхода, даже если сессию успели уничтожить (!leave/!stop).
        let joinedConnection = null;

        if (!session) {
            createdSession = true;
            session = client.createSession(message.guild.id, voiceChannel.id, message.channel.id);
            try {
                joinedConnection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: voiceChannel.guild.id,
                    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                    selfDeaf: true
                });
                
                await entersState(joinedConnection, VoiceConnectionStatus.Ready, client.config.timeouts.joinReady);

                // Пока ждали Ready, сессию могли уничтожить или заменить другой командой.
                if (session.destroyed || client.getSession(message.guild.id) !== session) {
                    destroyVoiceConnection(joinedConnection);
                    await statusMessage.edit(client.config.messages.joinFail).catch(() => {});
                    return;
                }

                if (session.setConnection(joinedConnection, message.channel) === false) {
                    // setConnection отказал уничтоженной сессии и сам закрыл соединение.
                    await statusMessage.edit(client.config.messages.joinFail).catch(() => {});
                    return;
                }
                logInfo(`Joined voice channel ${voiceChannel.id} on play`);
            } catch (error) {
                logError("Failed to join voice channel on play", error);
                destroyVoiceConnection(joinedConnection);
                // Не удаляем чужую (новую) сессию, если её успели пересоздать.
                if (client.getSession(message.guild.id) === session) {
                    client.deleteSession(message.guild.id);
                }
                await statusMessage.edit(client.config.messages.joinFail).catch(() => {});
                return;
            }
        }

        const trackInfoResult = await trackInfoPromise;
        if (!trackInfoResult.ok) {
            logError("Error fetching metadata", trackInfoResult.error);

            // Свежесозданную пустую сессию не оставляем висеть: отключаемся и убираем её.
            // Существующую сессию с играющим треком не трогаем.
            if (createdSession && session.tracks.length === 0) {
                try {
                    await session.destroy();
                } catch (destroyError) {
                    logError("Failed to destroy session after metadata error", destroyError);
                }
                // За время await сессию могли заменить (!join/!play) — чужую не удаляем.
                if (client.getSession(message.guild.id) === session) {
                    client.deleteSession(message.guild.id);
                }
            }

            await statusMessage.edit(client.config.messages.playError).catch(() => {});
            return;
        }

        // Сессию могли уничтожить (!leave/!stop) или заменить, пока ждали метаданные:
        // трек в такую сессию не добавляем, своё соединение закрываем.
        if (session.destroyed || client.getSession(message.guild.id) !== session) {
            destroyVoiceConnection(joinedConnection);
            await statusMessage.edit(client.config.messages.playError).catch(() => {});
            return;
        }

        try {
            const info = trackInfoResult.value;

            // Для platform-источников сразу отклоняем слишком длинные треки до добавления в очередь.
            const durationLimitSeconds = client.config.limits.maxTrackDurationSeconds;

            if (isPlatform && !info.isLive && info.durationMs != null
                && info.durationMs > durationLimitSeconds * 1000) {
                const minutes = Math.floor(durationLimitSeconds / 60);
                await statusMessage.edit(client.config.messages.trackTooLong.replace('{minutes}', minutes));
                return;
            }

            const isIdle = session.player.state.status === AudioPlayerStatus.Idle;
            const displayTitle = info.title || trackUrl;
            session.addTrack(trackUrl, displayTitle, message.channel, message.author.id, {
                isLive: info.isLive === true,
                durationMs: info.durationMs
            });

            if (isIdle) {
                await statusMessage.edit(client.config.messages.playNowPlaying.replace('{title}', displayTitle));
            } else {
                await statusMessage.edit(client.config.messages.playQueued.replace('{title}', displayTitle));
            }
        } catch (playError) {
            logError("Error adding track or updating status message", playError);
            await statusMessage.edit(client.config.messages.playError).catch(() => {});
        }
    }
};
