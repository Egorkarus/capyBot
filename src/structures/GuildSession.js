const { joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, StreamType } = require('@discordjs/voice');
const { AuditLogEvent } = require('discord.js');
const fsPromises = require('fs/promises');
const config = require('../config');
const { logInfo, logError, logWarn, logDebug } = require('../utils/logger');
const SafeHttpClient = require('../utils/SafeHttpClient');
const YtDlpClient = require('../utils/YtDlpClient');
const PlatformSource = require('../utils/PlatformSource');

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

// Прямые URL качает SafeHttpClient, поэтому тот же лимит применяется и к нему:
// security.maxFileSizeBytes не должен обходиться ссылкой вместо платформы.
const getMaxFileSizeLimitBytes = () => {
    const securityLimit = (config.security && config.security.maxFileSizeBytes)
        ? config.security.maxFileSizeBytes
        : FALLBACK_LIMITS.maxDownloadBytes;
    return Math.min(securityLimit, getDownloadLimitBytes());
};

class GuildSession {
    constructor(guildId, voiceChannelId, textChannelId) {
        this.guildId = guildId;
        this.voiceChannelId = voiceChannelId;
        this.textChannelId = textChannelId;
        
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.destroyed = false;
        
        this.player = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Play }
        });
        
        this.connection = null;
        this.subscription = null;
        this.tracks = [];
        this.currentFilePath = null;
        this.currentStreamJob = null;
        this.currentResource = null;
        this.textChannel = null;
        this.isProcessing = false;
        this.pendingNext = false;
        this.pendingTimers = new Set();
        this.downloadController = null;
        this.suppressIdleOnce = false;
        // Ограниченный ретрай после возврата трека из-за неготового соединения.
        this.connectionRetryCount = 0;
        // Текущая итерация вернула трек в очередь: повторный прогон цикла запрещён.
        this.lastIterationRequeued = false;

        this.player.on('stateChange', (oldState, newState) => {
            logDebug(`[DEBUG-PLAYER] State transitioned from ${oldState.status} to ${newState.status}`);
            if (newState.status === AudioPlayerStatus.Idle) {
                // Idle от собственного stop(): следующий трек запускать не нужно.
                if (this.suppressIdleOnce) {
                    this.suppressIdleOnce = false;
                    return;
                }

                logInfo(`Audio player idle in guild ${this.guildId}`);
                // Останавливаем живые процессы/потоки; файл почистит playNextTrack.
                if (this.currentStreamJob) {
                    this.currentStreamJob.stop().catch(err => logError('Error stopping stream job', err));
                    this.currentStreamJob = null;
                }
                this.playNextTrack().catch(err => logError('Failed to advance queue', err));
            }
        });

        this.player.on('debug', msg => {
            logDebug(`[DEBUG-PLAYER] ${msg}`);
        });

        this.player.on('error', async error => {
            logError(`Audio player error in guild ${this.guildId}`, error);
            await this._send(this.textChannel, config.messages.playerBroke);
            await this.cleanupCurrentFile();
            this.playNextTrack().catch(err => logError('Failed to advance queue after player error', err));
        });
    }

    setConnection(connection, textChannel) {
        // Сессию могли уничтожить (!leave/!stop), пока ждали Ready. Подписка на новое
        // соединение в этом случае оставила бы бота в канале-«зомби» без сессии.
        if (this.destroyed) {
            logWarn(`Refusing voice connection for destroyed session in guild ${this.guildId}`);
            try {
                connection.destroy();
            } catch (error) {
                logWarn('Failed to destroy orphan voice connection', error);
            }
            return false;
        }

        // После reconnect подписка должна переехать на новое соединение,
        // иначе плеер играет в старый (уже мёртвый) voice-connection.
        if (this.subscription) {
            try {
                this.subscription.unsubscribe();
            } catch (error) {
                logError('Failed to unsubscribe from previous voice connection', error);
            }
            this.subscription = null;
        }

        this.connection = connection;
        this.textChannel = textChannel;

        this.connection.on('stateChange', (oldState, newState) => {
            logDebug(`[DEBUG-CONN] State transitioned from ${oldState.status} to ${newState.status}`);
        });

        this.connection.on('debug', msg => {
            logDebug(`[DEBUG-CONN] ${msg}`);
        });

        this.connection.on('error', error => {
            logError(`[DEBUG-CONN] Error`, error);
        });

        this.subscription = this.connection.subscribe(this.player);

        // Успешный reconnect/join не должен оставлять очередь «спящей»: ретраи
        // после возврата трека ограничены и к этому моменту могли истечь.
        void this._wakeQueueIfIdle().catch(error => logError('Failed to wake queue after connection ready', error));
        return true;
    }

    async _send(channel, text) {
        if (!channel) return;
        try {
            await channel.send(text);
        } catch (error) {
            logError('Failed to send message', error);
        }
    }

    async cleanupCurrentFile() {
        // Активный ресурс держит файл открытым: на Windows rm упадёт с EPERM/EBUSY.
        if (this.currentResource) {
            try {
                this.currentResource.readStream?.destroy?.();
            } catch (error) {
                logWarn('Failed to destroy current audio resource stream', error);
            }
            this.currentResource = null;
        }

        if (!this.currentFilePath) return;

        const filePath = this.currentFilePath;
        this.currentFilePath = null;

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await fsPromises.rm(filePath, { force: true });
                return;
            } catch (error) {
                const isBusy = error.code === 'EPERM' || error.code === 'EBUSY';
                if (!isBusy || attempt === 3) {
                    logWarn(`Failed to remove temp file ${filePath}`, error);
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    }

    /**
     * Запускает следующий трек. Повторные вызовы во время обработки не теряются:
     * они взводят pendingNext, и цикл доигрывает очередь после текущей попытки.
     */
    async playNextTrack() {
        if (this.destroyed) return;

        if (this.isProcessing) {
            this.pendingNext = true;
            return;
        }

        this.isProcessing = true;

        try {
            let started;
            do {
                this.pendingNext = false;
                // Перед каждой повторной итерацией снимаем отложенный таймер,
                // иначе он запустит второй цикл поверх текущего.
                this._clearPendingTimers();
                started = await this._playNextTrackInternal();
                // Итерация вернула трек в очередь (соединение не готово): повторный
                // прогон снял бы и закачал тот же трек заново. Очередь разбудит
                // отложенный таймер ретрая.
                if (this.lastIterationRequeued) break;
            } while (this.pendingNext && !started);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * @returns {Promise<boolean>} true, если воспроизведение реально стартовало.
     */
    async _playNextTrackInternal() {
        this.lastIterationRequeued = false;
        await this.cleanupCurrentFile();

        if (this.tracks.length === 0) {
            await this._send(this.textChannel, config.messages.queueEnded);
            return false;
        }

        const nextTrack = this.tracks.shift();
        const currentTextChannel = nextTrack.textChannel || this.textChannel;
        const filePrefix = `track_${this.guildId}_${Date.now()}`;
        let tempFilePath = null;

        try {
            const isPlatform = PlatformSource.isPlatformUrl(nextTrack.url);
            this.downloadController = new AbortController();
            const downloadSignal = this.downloadController.signal;

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
                    await this._send(currentTextChannel, config.messages.trackTooLong
                        .replace('{minutes}', minutes)
                        .replace('{title}', effectiveTitle));
                    this._scheduleNextAfterCurrent();
                    return false;
                }

                // Реальная live-трансляция: стримим через yt-dlp stdout без скачивания на диск.
                if (isLive) {
                    let streamJob;
                    try {
                        streamJob = await YtDlpClient.createStreamJob(nextTrack.url, { signal: downloadSignal });
                    } catch (streamError) {
                        if (streamError && streamError.code === 'ABORTED') return false;
                        logError('Failed to start live stream job', streamError);
                        await this._send(currentTextChannel, config.messages.liveStreamFail.replace('{title}', effectiveTitle));
                        this._scheduleNextAfterCurrent();
                        return false;
                    }

                    this.currentStreamJob = streamJob;
                    await this._send(currentTextChannel, config.messages.liveStreamStarted.replace('{title}', effectiveTitle));
                    logInfo(`Playing live stream via yt-dlp stdout: ${nextTrack.url}`);

                    const connectionReady = await this._ensureConnectionReady();
                    if (!connectionReady) {
                        // Играть некуда, но трек не теряем: возвращаем его в начало очереди,
                        // если сессию не уничтожили и загрузку не отменили. Иначе трек попал бы
                        // в мёртвую сессию, а в канал ушло бы сообщение после выхода.
                        await this._returnTrackIfAlive(nextTrack, downloadSignal, currentTextChannel);
                    }

                    // Сессию могли уничтожить или загрузку отменить (skip/stop),
                    // пока ждали готовности соединения.
                    if (!connectionReady || this.destroyed || downloadSignal.aborted) {
                        try {
                            await streamJob.stop();
                        } catch (error) {
                            logWarn('Failed to stop stream job after failed start', error);
                        }
                        if (this.currentStreamJob === streamJob) {
                            this.currentStreamJob = null;
                        }
                        return false;
                    }

                    // stdout yt-dlp — произвольный контейнер (webm/opus/m4a), поэтому Arbitrary:
                    // @discordjs/voice через ffmpeg перекодирует в Opus для Discord.
                    const liveResource = createAudioResource(streamJob.stream, {
                        inputType: StreamType.Arbitrary
                    });
                    this.currentResource = liveResource;
                    this.player.play(liveResource);
                    this._clearPendingTimers();
                    this.connectionRetryCount = 0;
                    logInfo(`Started live stream playback in guild ${this.guildId}`);
                    return true;
                }

                // Обычный трек: скачиваем аудио в файл.
                await this._send(currentTextChannel, config.messages.downloading.replace('{title}', effectiveTitle));
                logInfo(`Downloading track via yt-dlp: ${nextTrack.url}`);

                const outputPathPattern = `temp/${filePrefix}.%(ext)s`;
                try {
                    await YtDlpClient.downloadFile(nextTrack.url, outputPathPattern, getDurationLimitMs(), {
                        signal: downloadSignal
                    });
                } catch (downloadError) {
                    if (downloadError && downloadError.code === 'ABORTED') return false;

                    if (downloadError.message === 'TOO_LONG') {
                        const minutes = Math.floor(getDurationLimitSeconds() / 60);
                        await this._send(currentTextChannel, config.messages.trackTooLong
                            .replace('{minutes}', minutes)
                            .replace('{title}', effectiveTitle));
                        this._scheduleNextAfterCurrent();
                        return false;
                    }
                    throw downloadError;
                }

                const files = await fsPromises.readdir('temp');
                const matchedFile = files.find(f => f.startsWith(filePrefix));
                if (!matchedFile) throw new Error("Downloaded file not found on disk");

                tempFilePath = `temp/${matchedFile}`;

                // Контроль реального размера файла на диске (лимит скачивания).
                const fileStat = await fsPromises.stat(tempFilePath);
                if (fileStat.size > getMaxFileSizeLimitBytes()) {
                    await fsPromises.rm(tempFilePath, { force: true }).catch(() => {});
                    await this._send(currentTextChannel, config.messages.trackTooBig.replace('{title}', effectiveTitle));
                    this._scheduleNextAfterCurrent();
                    return false;
                }
            } else {
                // Прямая ссылка/вложение: качаем файл.
                await this._send(currentTextChannel, config.messages.downloading.replace('{title}', nextTrack.title));
                logInfo(`Downloading direct file: ${nextTrack.url}`);
                tempFilePath = `temp/${filePrefix}.mp3`;
                await SafeHttpClient.download(nextTrack.url, tempFilePath, {
                    signal: downloadSignal,
                    maxBytes: getMaxFileSizeLimitBytes()
                });
            }

            if (this.destroyed) {
                await fsPromises.rm(tempFilePath, { force: true }).catch(() => {});
                return false;
            }

            if (!(await this._ensureConnectionReady())) {
                // Трек уже снят с очереди (shift выше), поэтому возвращаем его обратно:
                // временный сбой соединения не должен «съедать» трек пользователя.
                // Возврат и сообщение — только для живой сессии и неотменённой загрузки.
                await this._returnTrackIfAlive(nextTrack, downloadSignal, currentTextChannel);
                // Играть некуда: не оставляем скачанный файл в temp.
                await fsPromises.rm(tempFilePath, { force: true }).catch(() => {});
                return false;
            }

            // Сессию могли уничтожить, пока ждали готовности соединения:
            // скачанный файл уже некому играть, поэтому удаляем его сразу.
            if (this.destroyed) {
                await fsPromises.rm(tempFilePath, { force: true }).catch(() => {});
                return false;
            }

            // Загрузку отменили (skip/stop) уже после скачивания — играть нечего,
            // файл удаляем без сообщений в чат.
            if (downloadSignal.aborted) {
                await fsPromises.rm(tempFilePath, { force: true }).catch(() => {});
                return false;
            }

            this.currentFilePath = tempFilePath;
            // mp3/opus с диска транскодируются Discord'ом автоматически (встроенный ffmpeg).
            const resource = createAudioResource(tempFilePath);
            this.currentResource = resource;
            this.player.play(resource);
            this._clearPendingTimers();
            this.connectionRetryCount = 0;
            logInfo(`Started playing file in guild ${this.guildId}`);
            return true;
        } catch (error) {
            // Отмена загрузки (skip/stop/leave) — штатный сценарий, не ошибка.
            if (error && error.code === 'ABORTED') {
                return false;
            }

            // Диагностика: логируем реальную ошибку (причину сбоя yt-dlp/скачивания),
            // чтобы её было видно в логах и можно было передать пользователю.
            const errMsg = (error && error.message) ? error.message : String(error);
            logError(`[download] Failed for URL in playNextTrack: ${errMsg}`);

            // Сессию могли уничтожить (!leave/!stop): в мёртвый канал не пишем.
            if (!this.destroyed) {
                const baseMsg = config.messages.downloadFail.replace('{title}', nextTrack.title);
                // Не выводим сами URL/чувствительные данные; только краткую причину.
                const shortReason = errMsg.length > 180 ? errMsg.slice(0, 177) + '...' : errMsg;
                await this._send(currentTextChannel, `${baseMsg}\n_Причина: \`${shortReason}\`_`);
            }

            await this.cleanupCurrentFile();
            this._scheduleNextAfterCurrent();
            return false;
        }
    }

    _scheduleNextAfterCurrent() {
        if (this.tracks.length === 0) return;
        // Пока трек играет, отложенный запуск оборвал бы его на середине:
        // следующий трек стартует из обработчика Idle или по явному skip.
        if (this.player.state.status !== AudioPlayerStatus.Idle) return;

        const timer = setTimeout(() => {
            this.pendingTimers.delete(timer);
            this.playNextTrack().catch(error => logError('Failed to play next track', error));
        }, 1000);

        this.pendingTimers.add(timer);
    }

    _clearPendingTimers() {
        for (const timer of this.pendingTimers) {
            clearTimeout(timer);
        }
        this.pendingTimers.clear();
    }

    /**
     * Будит очередь после восстановления соединения: длинный reconnect (2→32 с)
     * переживает ограниченные ретраи, поэтому без этого вызова трек висел бы
     * в очереди до следующей команды пользователя. Дублирование исключено
     * guard-ом isProcessing внутри playNextTrack.
     */
    async _wakeQueueIfIdle() {
        if (this.destroyed || this.isProcessing) return;
        if (this.player.state.status !== AudioPlayerStatus.Idle) return;
        if (this.tracks.length === 0) return;
        await this.playNextTrack();
    }

    /**
     * Возвращает снятый с очереди трек, если сессия жива и загрузку не отменили
     * (skip/stop/leave), и сообщает о неготовом соединении. Обе ветки — файловая
     * и live — используют это правило, чтобы не пополнять уничтоженную сессию.
     */
    async _returnTrackIfAlive(nextTrack, downloadSignal, textChannel) {
        if (this.destroyed || downloadSignal.aborted) return;

        this.tracks.unshift(nextTrack);
        this.lastIterationRequeued = true;
        await this._send(textChannel, config.messages.playerBroke);

        // Без ретрая очередь «висит» в Idle до следующей команды. Число попыток
        // ограничено, чтобы необратимо мёртвое соединение не крутило цикл вечно.
        if (this.connectionRetryCount < 2) {
            this.connectionRetryCount += 1;
            this._scheduleNextAfterCurrent();
        }
    }

    async _ensureConnectionReady() {
        if (!this.connection) return false;

        // entersState на уничтоженном соединении никогда не даст Ready —
        // сразу выходим, чтобы не ждать таймаут впустую.
        if (this.connection.state.status === VoiceConnectionStatus.Destroyed) {
            logWarn(`Voice connection is destroyed in guild ${this.guildId}`);
            return false;
        }

        if (this.connection.state.status === VoiceConnectionStatus.Ready) return true;

        try {
            await entersState(this.connection, VoiceConnectionStatus.Ready, 3000);
            return true;
        } catch (error) {
            logError('Voice connection is not ready', error);
            return false;
        }
    }

    addTrack(url, title, textChannel = null, userId = null, meta = {}) {
        if (this.destroyed) return;

        this.tracks.push({
            url,
            title,
            textChannel,
            userId,
            isLive: meta.isLive === true,
            trackDurationMs: meta.durationMs != null ? meta.durationMs : null
        });
        if (this.player.state.status === AudioPlayerStatus.Idle) {
            this.playNextTrack().catch(error => logError('Failed to start playback', error));
        }
    }

    async skip() {
        // Прерываем активную загрузку, иначе следующий трек стартует поверх неё.
        this.downloadController?.abort();
        if (this.isProcessing) {
            this.pendingNext = true;
        }
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
        this._clearPendingTimers();
        this.downloadController?.abort();

        // Подавляем Idle от собственного stop(), иначе playNextTrack запустит следующий трек.
        this.suppressIdleOnce = this.player.state.status !== AudioPlayerStatus.Idle;
        this.player.stop();
        
        if (this.currentStreamJob) {
            try {
                await this.currentStreamJob.stop();
            } catch (error) {
                logError('Failed to stop stream job', error);
            }
            this.currentStreamJob = null;
        }
        
        if (this.subscription) {
            try {
                this.subscription.unsubscribe();
            } catch (error) {
                logWarn('Failed to unsubscribe on stop', error);
            }
            this.subscription = null;
        }
        
        await this.cleanupCurrentFile();
    }

    async destroy() {
        this.destroyed = true;
        this._clearPendingTimers();

        await this.stop();

        if (this.connection) {
            try {
                this.connection.destroy();
            } catch (error) {
                logWarn('Failed to destroy voice connection', error);
            }
            this.connection = null;
        }
    }

    async reconnect(client, guildId) {
        if (this.destroyed) return;
        if (client.getSession(guildId) !== this) return;
        if (this.isReconnecting) return;

        this.isReconnecting = true;
        this.reconnectAttempts = 0;

        try {
            const guild = client.guilds.cache.get(guildId);
            if (guild && this.textChannel) {
                const kicker = await this.findKicker(guild, client.user.id);
                const msg = kicker ? config.messages.reconnectKickedKnown.replace('{kicker}', kicker) : config.messages.reconnectKickedUnknown;
                await this._send(this.textChannel, msg);
            }

            // Пока ждали отправки сообщения, сессию могли заменить (!join/!play):
            // чужую сессию не переподключаем.
            if (client.getSession(guildId) !== this) return;

            // Уничтожаем только собственное соединение: в реестре Discord может
            // оказаться соединение, созданное параллельной командой, и его трогать нельзя.
            if (this.connection) {
                try {
                    this.connection.destroy();
                } catch (error) {
                    logWarn('Failed to destroy stale voice connection', error);
                }
                this.connection = null;
            }

            while (this.reconnectAttempts < config.timeouts.reconnectMaxAttempts) {
                this.reconnectAttempts++;

                if (this.destroyed) return;

                const delay = config.timeouts.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1);
                await new Promise(res => setTimeout(res, delay));

                if (this.destroyed) return;

                const activeGuild = client.guilds.cache.get(guildId);
                if (!activeGuild) {
                    this._deleteSessionIfOwner(client, guildId);
                    return;
                }

                const channel = activeGuild.channels.cache.get(this.voiceChannelId);
                if (!channel) {
                    await this._send(this.textChannel, config.messages.reconnectNoChannel);
                    this._deleteSessionIfOwner(client, guildId);
                    return;
                }

                let connection = null;
                try {
                    connection = joinVoiceChannel({
                        channelId: this.voiceChannelId,
                        guildId: guildId,
                        adapterCreator: activeGuild.voiceAdapterCreator,
                        selfDeaf: true
                    });

                    await entersState(connection, VoiceConnectionStatus.Ready, config.timeouts.joinReady * 2);

                    // Пока ждали Ready, сессию могли уничтожить (!leave/!stop) или заменить новой.
                    // В этом случае соединение не подписываем, иначе бот останется в канале-«зомби».
                    if (this.destroyed || client.getSession(guildId) !== this) {
                        try {
                            connection.destroy();
                        } catch (destroyError) {
                            logWarn('Failed to destroy orphan voice connection after reconnect', destroyError);
                        }
                        return;
                    }

                    this.setConnection(connection, this.textChannel);

                    await this._send(this.textChannel, config.messages.reconnectSuccess);
                    // Подписка уже переехала на новое соединение (setConnection):
                    // возвращаем отложенную очередь в работу, не дожидаясь команд.
                    void this._wakeQueueIfIdle().catch(error => logError('Failed to wake queue after reconnect', error));
                    return;
                } catch (error) {
                    logError(`Reconnect attempt ${this.reconnectAttempts} failed`, error);
                    // Уничтожаем только соединение этой итерации: в реестре Discord
                    // может оказаться соединение, созданное другой командой.
                    if (connection) {
                        try {
                            connection.destroy();
                        } catch (destroyError) {
                            logWarn('Failed to destroy failed voice connection', destroyError);
                        }
                    }
                }
            }

            await this._send(this.textChannel, config.messages.reconnectGiveUp);
            this._deleteSessionIfOwner(client, guildId);
        } finally {
            // Сбрасываем состояние на всех ветках выхода, иначе повторный reconnect не запустится.
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
        }
    }

    _deleteSessionIfOwner(client, guildId) {
        // Между await сессию могли заменить (!join/!play): чужую не удаляем.
        if (client.getSession(guildId) === this) client.deleteSession(guildId);
    }

    async findKicker(guild, botId) {
        try {
            const auditLogs = await guild.fetchAuditLogs({ limit: 5, type: AuditLogEvent.MemberDisconnect });
            const currentTimestamp = Date.now();
            const entry = auditLogs.entries.find(e => e.target?.id === botId && (currentTimestamp - e.createdTimestamp) < config.timeouts.kickCheckWindowMs);
            return entry ? entry.executor.username : null;
        } catch (error) {
            logWarn('Failed to read audit logs for kick detection', error);
            return null;
        }
    }

    /**
     * Получает метаданные трека (title, длительность, live-статус).
     * Для платформ использует yt-dlp fetchInfo; для прямых URL выводит название из пути.
     * @returns {Promise<{title: string, durationMs: number|null, isLive: boolean}>}
     */
    static async fetchTrackInfo(url) {
        if (PlatformSource.isPlatformUrl(url)) {
            return await YtDlpClient.fetchInfo(url);
        }

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

module.exports = GuildSession;
// Экспорт для юнит-тестов: лимит прямых URL = min(security.maxFileSizeBytes, limits.maxDownloadBytes).
module.exports.getMaxFileSizeLimitBytes = getMaxFileSizeLimitBytes;
