const { joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection, StreamType } = require('@discordjs/voice');
const { AuditLogEvent } = require('discord.js');
const fsPromises = require('fs/promises');
const fs = require('fs');
const config = require('../config');
const { logInfo, logError } = require('../utils/logger');
const SafeHttpClient = require('../utils/SafeHttpClient');
const YtDlpClient = require('../utils/YtDlpClient');

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
                if (this.currentStreamJob) {
                    this.currentStreamJob.stop().catch(err => logError('Error stopping stream job', err));
                    this.currentStreamJob = null;
                }
                this.cleanupCurrentFile();
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

            if (isYoutube || isSoundcloud || isTwitch) {
                try {
                    const streamJob = await YtDlpClient.createStreamJob(nextTrack.url);
                    this.currentStreamJob = streamJob;

                    if (currentTextChannel) {
                        currentTextChannel.send(`🍊📡 Подключаюсь к трансляции...\n**${nextTrack.title}**`);
                    }
                    logInfo(`Playing stream directly via yt-dlp: ${nextTrack.url}`);
                } catch (streamError) {
                    logError('Failed to create stream, falling back to download', streamError);
                    
                    if (currentTextChannel) {
                        currentTextChannel.send(`Не могу получить прямой поток для **${nextTrack.title}**, пробую скачать... 🍊📥`);
                    }
                    
                    logInfo(`Downloading track via yt-dlp: ${nextTrack.url}`);
                    const outputPathPattern = `temp/${filePrefix}.%(ext)s`;
                    await YtDlpClient.downloadFile(nextTrack.url, outputPathPattern);
                    
                    const files = await fsPromises.readdir('temp');
                    const matchedFile = files.find(f => f.startsWith(filePrefix));
                    if (!matchedFile) throw new Error("Downloaded file not found on disk");
                    
                    tempFilePath = `temp/${matchedFile}`;
                    playTarget = tempFilePath;
                }
            } else {
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

            this.currentFilePath = tempFilePath;
            
            let resource;
            if (this.currentStreamJob) {
                resource = createAudioResource(this.currentStreamJob.stream);
            } else {
                resource = createAudioResource(playTarget);
            }
            this.player.play(resource);
            logInfo(`Started playing in guild ${this.guildId}`);
        } catch (error) {
            logError("Error in playNextTrack", error);
            if (currentTextChannel) {
                currentTextChannel.send(`Не могу воспроизвести трек **${nextTrack.title}**, пропускаю. 🍊`);
            }
            
            await this.cleanupCurrentFile();
            
            if (this.tracks.length > 0) {
                setTimeout(() => this.playNextTrack(), 1000);
            }
        }
    }

    addTrack(url, title, textChannel = null, userId = null) {
        this.tracks.push({ url, title, textChannel, userId });
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



    static async fetchTrackTitle(url) {
        const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
        const isSoundcloud = url.includes('soundcloud.com');
        const isTwitch = url.includes('twitch.tv');
        
        if (isYoutube || isSoundcloud || isTwitch) {
            return await YtDlpClient.fetchTitle(url);
        } else {
            try {
                const parsedUrl = new URL(url);
                const pathParts = parsedUrl.pathname.split('/');
                return decodeURIComponent(pathParts[pathParts.length - 1]) || url;
            } catch {
                return url;
            }
        }
    }
}

module.exports = GuildSession;
