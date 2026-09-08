const { joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection, StreamType } = require('@discordjs/voice');
const { AuditLogEvent } = require('discord.js');
const fsPromises = require('fs/promises');
const fs = require('fs');
const config = require('../config');
const { logInfo, logError } = require('../utils/logger');
const SafeHttpClient = require('../utils/SafeHttpClient');
const YtDlpClient = require('../utils/YtDlpClient');

// Резервные значения лимитов на случай, если config.limits не загрузился
// (защита от TypeError при частично устаревшем конфиге в контейнере).
const FALLBACK_LIMITS = {
    maxTrackDurationSeconds: 1800, // 30 мин
    maxDownloadBytes: 70 * 1024 * 1024
};

const getDurationLimitMs = () =>
    (config.limits && config.limits.maxTrackDurationSeconds)
        ? config.limits.maxTrackDurationSeconds * 1000
        : FALLBACK_LIMITS.maxTrackDurationSeconds * 1000;

const getDurationLimitSeconds = () =>
    (config.limits && config.limits.maxTrackDurationSeconds)
        ? config.limits.maxTrackDurationSeconds
        : FALLBACK_LIMITS.maxTrackDurationSeconds;

const getDownloadLimitBytes = () =>
    (config.limits && config.limits.maxDownloadBytes)
        ? config.limits.maxDownloadBytes
        : FALLBACK_LIMITS.maxDownloadBytes;

class GuildSession {
    constructor(guildId, voiceChannelId, textChannelId) {
        this.guildId = guildId;
        this.voiceChannelId = voiceChannelId;
        this.textChannelId = textChannelId;
        
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        
        this.player = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Play }
        });
        
        this.connection = null;
        this.subscription = null;
        this.tracks = [];
        this.currentFilePath = null;
        this.currentStreamJob = null;
        this.textChannel = null;
        this.isProcessing = false;

        this.player.on('stateChange', (oldState, newState) => {
            logInfo(`[DEBUG-PLAYER] State transitioned from ${oldState.status} to ${newState.status}`);
            if (newState.status === AudioPlayerStatus.Idle) {
                logInfo(`Audio player idle in guild ${this.guildId}`);
                // Останавливаем живые процессы/потоки; файл почистит playNextTrack.
                if (this.currentStreamJob) {
                    this.currentStreamJob.stop().catch(err => logError('Error stopping stream job', err));
                    this.currentStreamJob = null;
                }
                this.playNextTrack();
            }
        });

        this.player.on('debug', msg => {
            logInfo(`[DEBUG-PLAYER] ${msg}`);
        });

        this.player.on('error', async error => {
            logError(`Audio player error in guild ${this.guildId}`, error);
            if (this.textChannel) {
                this.textChannel.send(config.messages.playerBroke);
            }
            await this.cleanupCurrentFile();
            this.playNextTrack();
        });
    }

    setConnection(connection, textChannel) {
        this.connection = connection;
        this.textChannel = textChannel;

        this.connection.on('stateChange', (oldState, newState) => {
            logInfo(`[DEBUG-CONN] State transitioned from ${oldState.status} to ${newState.status}`);
        });

        this.connection.on('debug', msg => {
            logInfo(`[DEBUG-CONN] ${msg}`);
        });

        this.connection.on('error', error => {
            logError(`[DEBUG-CONN] Error`, error);
        });

        if (!this.subscription) {
            this.subscription = this.connection.subscribe(this.player);
        }
    }

    async cleanupCurrentFile() {
        if (!this.currentFilePath) return;
        await fsPromises.rm(this.currentFilePath, { force: true }).catch(() => {});
        this.currentFilePath = null;
    }

    async playNextTrack() {
        if (this.isProcessing) {
            logInfo(`Already processing track in guild ${this.guildId}, skipping duplicate call`);
            return;
        }
        
        this.isProcessing = true;
        
        try {
            await this._playNextTrackInternal();
        } finally {
            this.isProcessing = false;
        }
    }

    async _playNextTrackInternal() {
        await this.cleanupCurrentFile();

        if (this.tracks.length === 0) {
            if (this.textChannel) {
                this.textChannel.send(config.messages.queueEnded);
            }
            return;
        }

        const nextTrack = this.tracks.shift();
        const currentTextChannel = nextTrack.textChannel || this.textChannel;
        const filePrefix = `track_${this.guildId}_${Date.now()}`;
        let tempFilePath = null;
        let playTarget = null;

        try {
            const isYoutube = nextTrack.url.includes('youtube.com') || nextTrack.url.includes('youtu.be');
            const isSoundcloud = nextTrack.url.includes('soundcloud.com');
            const isTwitch = nextTrack.url.includes('twitch.tv');
            const isPlatform = isYoutube || isSoundcloud || isTwitch;

            // Вариант A: обычные платформенные треки скачиваем в файл (стабильно и играбельно),
            // прямой live-стрим (raw stdout) оставляем только для реальных трансляций.
            if (isPlatform) {
                const isLive = nextTrack.isLive === true;
                const effectiveTitle = nextTrack.title;

                // Защита от "10-гигабайтных" потоков: обычное видео/аудио не длиннее лимита
                // (длительность уже проверялась в play.js при добавлении; дублируем подстраховка
                // на случай long треков, добавленных иным путём).
                if (!isLive && nextTrack.trackDurationMs != null
                    && nextTrack.trackDurationMs > getDurationLimitMs()) {
                    const minutes = Math.floor(getDurationLimitSeconds() / 60);
                    if (currentTextChannel) {
                        currentTextChannel.send(config.messages.trackTooLong
                            .replace('{minutes}', minutes)
                            .replace('{title}', effectiveTitle));
                    }
                    this._scheduleNextAfterCurrent();
                    return;
                }

                // Реальная live-трансляция: стримим через yt-dlp stdout без скачивания на диск.
                if (isLive) {
                    let streamJob;
                    try {
                        streamJob = await YtDlpClient.createStreamJob(nextTrack.url);
                    } catch (streamError) {
                        logError('Failed to start live stream job', streamError);
                        if (currentTextChannel) {
                            currentTextChannel.send(config.messages.liveStreamFail.replace('{title}', effectiveTitle));
                        }
                        this._scheduleNextAfterCurrent();
                        return;
                    }

                    this.currentStreamJob = streamJob;
                    if (currentTextChannel) {
                        currentTextChannel.send(config.messages.liveStreamStarted.replace('{title}', effectiveTitle));
                    }
                    logInfo(`Playing live stream via yt-dlp stdout: ${nextTrack.url}`);

                    if (this.connection && this.connection.state.status === VoiceConnectionStatus.Ready) {
                        this.connection.rejoin();
                    }

                    this.currentFilePath = null;
                    // stdout yt-dlp 一произвольный контейнер (webm/opus/m4a), поэтому Arbitrary:
                    // @discordjs/voice через ffmpeg перекодирует в Opus для Discord.
                    const liveResource = createAudioResource(streamJob.stream, {
                        inputType: StreamType.Arbitrary
                    });
                    this.player.play(liveResource);
                    logInfo(`Started live stream playback in guild ${this.guildId}`);
                    return;
                }

                // Обычный трек: скачиваем аудио в файл.
                if (currentTextChannel) {
                    currentTextChannel.send(config.messages.downloading.replace('{title}', effectiveTitle));
                }
                logInfo(`Downloading track via yt-dlp: ${nextTrack.url}`);

                const outputPathPattern = `temp/${filePrefix}.%(ext)s`;
                try {
                    await YtDlpClient.downloadFile(nextTrack.url, outputPathPattern, getDurationLimitMs());
                } catch (downloadError) {
                    if (downloadError.message === 'TOO_LONG') {
                        const minutes = Math.floor(getDurationLimitSeconds() / 60);
                        if (currentTextChannel) {
                            currentTextChannel.send(config.messages.trackTooLong
                                .replace('{minutes}', minutes)
                                .replace('{title}', effectiveTitle));
                        }
                        this._scheduleNextAfterCurrent();
                        return;
                    }
                    throw downloadError;
                }

                const files = await fsPromises.readdir('temp');
                const matchedFile = files.find(f => f.startsWith(filePrefix));
                if (!matchedFile) throw new Error("Downloaded file not found on disk");

                tempFilePath = `temp/${matchedFile}`;

                // Контроль реального размера файла на диске (лимит скачивания).
                const fileStat = await fsPromises.stat(tempFilePath);
                if (fileStat.size > getDownloadLimitBytes()) {
                    await fsPromises.rm(tempFilePath, { force: true }).catch(() => {});
                    if (currentTextChannel) {
                        currentTextChannel.send(config.messages.trackTooBig.replace('{title}', effectiveTitle));
                    }
                    this._scheduleNextAfterCurrent();
                    return;
                }

                playTarget = tempFilePath;
            } else {
                // Прямая ссылка/вложение: качаем файл.
                if (currentTextChannel) {
                    currentTextChannel.send(config.messages.downloading.replace('{title}', nextTrack.title));
                }
                logInfo(`Downloading direct file: ${nextTrack.url}`);
                tempFilePath = `temp/${filePrefix}.mp3`;
                await SafeHttpClient.download(nextTrack.url, tempFilePath);
                playTarget = tempFilePath;
            }

            if (this.connection && this.connection.state.status === VoiceConnectionStatus.Ready) {
                this.connection.rejoin();
            }

            this.currentFilePath = playTarget;
            // mp3/opus с диска транскодируются Discord'ом автоматически (встроенный ffmpeg).
            const resource = createAudioResource(playTarget);
            this.player.play(resource);
            logInfo(`Started playing file in guild ${this.guildId}`);
        } catch (error) {
            // Диагностика: логируем реальную ошибку (причину сбоя yt-dlp/скачивания),
            // чтобы её было видно и в логах and можно было передать пользователю.
            const errMsg = (error && error.message) ? error.message : String(error);
            logError(`[download] Failed for URL in playNextTrack: ${errMsg}`);

            if (currentTextChannel) {
                const baseMsg = config.messages.downloadFail.replace('{title}', nextTrack.title);
                // Не выводим сами URL/чувствительные данные; только краткую причину.
                const shortReason = errMsg.length > 180 ? errMsg.slice(0, 177) + '...' : errMsg;
                currentTextChannel.send(`${baseMsg}\n_Причина: \`${shortReason}\`_`);
            }

            await this.cleanupCurrentFile();
            this._scheduleNextAfterCurrent();
        }
    }

    _scheduleNextAfterCurrent() {
        if (this.tracks.length > 0) {
            setTimeout(() => this.playNextTrack(), 1000);
        }
    }

    addTrack(url, title, textChannel = null, userId = null, meta = {}) {
        this.tracks.push({
            url,
            title,
            textChannel,
            userId,
            isLive: meta.isLive === true,
            trackDurationMs: meta.durationMs != null ? meta.durationMs : null
        });
        if (this.player.state.status === AudioPlayerStatus.Idle) {
            this.playNextTrack();
        }
    }

    async skip() {
        this.player.stop();
        await this.cleanupCurrentFile();
        logInfo(`Skipped current track in guild ${this.guildId}`);
    }

    pause() {
        this.player.pause();
    }

    resume() {
        this.player.unpause();
    }

    async stop() {
        this.tracks = [];
        this.player.stop();
        
        if (this.currentStreamJob) {
            await this.currentStreamJob.stop();
            this.currentStreamJob = null;
        }
        
        if (this.subscription) {
            this.subscription.unsubscribe();
            this.subscription = null;
        }
        
        await this.cleanupCurrentFile();
    }

    async destroy() {
        await this.stop();
        if (this.connection) {
            this.connection.destroy();
        }
    }

    async reconnect(client, guildId) {
        if (this.isReconnecting) return;
        this.isReconnecting = true;
        this.reconnectAttempts = 0;

        const guild = client.guilds.cache.get(guildId);
        if (guild && this.textChannel) {
            const kicker = await this.findKicker(guild, client.user.id);
            const msg = kicker ? config.messages.reconnectKickedKnown.replace('{kicker}', kicker) : config.messages.reconnectKickedUnknown;
            this.textChannel.send(msg);
        }

        const existingConnection = getVoiceConnection(guildId);
        if (existingConnection) {
            try { existingConnection.destroy(); } catch (err) {}
        }

        while (this.reconnectAttempts < config.timeouts.reconnectMaxAttempts) {
            this.reconnectAttempts++;
            const delay = config.timeouts.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1);
            await new Promise(res => setTimeout(res, delay));

            const activeGuild = client.guilds.cache.get(guildId);
            if (!activeGuild) {
                client.deleteSession(guildId);
                return;
            }

            const channel = activeGuild.channels.cache.get(this.voiceChannelId);
            if (!channel) {
                if (this.textChannel) this.textChannel.send(config.messages.reconnectNoChannel);
                client.deleteSession(guildId);
                return;
            }

            try {
                const connection = joinVoiceChannel({
                    channelId: this.voiceChannelId,
                    guildId: guildId,
                    adapterCreator: activeGuild.voiceAdapterCreator,
                    selfDeaf: true
                });

                await entersState(connection, VoiceConnectionStatus.Ready, config.timeouts.joinReady * 2);
                this.setConnection(connection, this.textChannel);
                
                if (this.textChannel) {
                    this.textChannel.send(config.messages.reconnectSuccess);
                }

                this.reconnectAttempts = 0;
                this.isReconnecting = false;
                return;
            } catch (error) {
                logError(`Reconnect attempt ${this.reconnectAttempts} failed`, error);
                const conn = getVoiceConnection(guildId);
                if (conn) {
                    try { conn.destroy(); } catch (err) {}
                }
            }
        }

        if (this.textChannel) {
            this.textChannel.send(config.messages.reconnectGiveUp);
        }
        client.deleteSession(guildId);
    }

    async findKicker(guild, botId) {
        try {
            const auditLogs = await guild.fetchAuditLogs({ limit: 5, type: AuditLogEvent.MemberDisconnect });
            const currentTimestamp = Date.now();
            const entry = auditLogs.entries.find(e => e.target?.id === botId && (currentTimestamp - e.createdTimestamp) < config.timeouts.kickCheckWindowMs);
            return entry ? entry.executor.username : null;
        } catch (error) {
            return null;
        }
    }



    /**
     * Получает метаданные трека (title, длительность, live-статус).
     * Для платформ использует yt-dlp fetchInfo; для прямых URL выводит название из пути.
     * @returns {Promise<{title: string, durationMs: number|null, isLive: boolean}>}
     */
    static async fetchTrackInfo(url) {
        const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
        const isSoundcloud = url.includes('soundcloud.com');
        const isTwitch = url.includes('twitch.tv');

        if (isYoutube || isSoundcloud || isTwitch) {
            return await YtDlpClient.fetchInfo(url);
        } else {
            try {
                const parsedUrl = new URL(url);
                const pathParts = parsedUrl.pathname.split('/');
                const filename = decodeURIComponent(pathParts[pathParts.length - 1]) || url;
                return { title: filename, durationMs: null, isLive: false };
            } catch {
                return { title: url, durationMs: null, isLive: false };
            }
        }
    }
}

module.exports = GuildSession;
