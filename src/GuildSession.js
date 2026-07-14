const { joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection } = require('@discordjs/voice');
const { AuditLogEvent } = require('discord.js');
const fsPromises = require('fs/promises');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const config = require('./config');
const { logInfo, logError } = require('./logger');

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
        this.textChannel = null;

        this.player.on('stateChange', (oldState, newState) => {
            logInfo(`[DEBUG-PLAYER] State transitioned from ${oldState.status} to ${newState.status}`);
        });

        this.player.on('debug', msg => {
            logInfo(`[DEBUG-PLAYER] ${msg}`);
        });

        this.player.on(AudioPlayerStatus.Idle, async () => {
            logInfo(`Audio player idle in guild ${this.guildId}`);
            await this.cleanupCurrentFile();
            this.playNextTrack();
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
        await this.cleanupCurrentFile();

        if (this.tracks.length === 0) {
            if (this.textChannel) {
                this.textChannel.send(config.messages.queueEnded);
            }
            // NOTE: Оставляем подписку активной даже при пустой очереди.
            // Если тут сделать unsubscribe(), то следующий добавленный трек 
            // улетит в пустоту и будет играть без звука.
            return;
        }

        const nextTrack = this.tracks.shift();
        const filePrefix = `track_${this.guildId}_${Date.now()}`;
        let tempFilePath = '';

        try {
            if (this.textChannel) {
                this.textChannel.send(config.messages.downloading.replace('{title}', nextTrack.title));
            }
            
            const isYoutube = nextTrack.url.includes('youtube.com') || nextTrack.url.includes('youtu.be');
            const isSoundcloud = nextTrack.url.includes('soundcloud.com');
            
            if (isYoutube || isSoundcloud) {
                logInfo(`Downloading via yt-dlp: ${nextTrack.url}`);
                const outputPathPattern = `temp/${filePrefix}.%(ext)s`;
                await this.downloadViaYtDlp(nextTrack.url, outputPathPattern);
                
                const files = await fsPromises.readdir('temp');
                const matchedFile = files.find(f => f.startsWith(filePrefix));
                if (!matchedFile) throw new Error("Downloaded file not found on disk");
                
                tempFilePath = `temp/${matchedFile}`;
            } else {
                logInfo(`Downloading direct MP3: ${nextTrack.url}`);
                tempFilePath = `temp/${filePrefix}.mp3`;
                await this.downloadDirectFile(nextTrack.url, tempFilePath);
            }

            // NOTE: Микро-реконнект перед каждым новым треком. 
            // Это сбрасывает таймаут UDP на стороне Discord (чтобы не пропадал звук после долгой скачки).
            if (this.connection && this.connection.state.status === VoiceConnectionStatus.Ready) {
                this.connection.rejoin();
            }

            this.currentFilePath = tempFilePath;
            const resource = createAudioResource(tempFilePath);
            this.player.play(resource);
            logInfo(`Started playing ${tempFilePath} in guild ${this.guildId}`);
        } catch (error) {
            logError(`Failed to download/play ${nextTrack.url}`, error);
            if (this.textChannel) {
                this.textChannel.send(config.messages.downloadFail.replace('{title}', nextTrack.title));
            }
            await this.cleanupCurrentFile();
            this.playNextTrack();
        }
    }

    addTrack(url, title) {
        this.tracks.push({ url, title });
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
        if (this.subscription) {
            this.subscription.unsubscribe();
            this.subscription = null;
        }
        await this.cleanupCurrentFile();
    }

    destroy() {
        this.stop();
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

    downloadViaYtDlp(url, outputPathPattern) {
        return new Promise((resolve, reject) => {
            // NOTE: Конвертим всё в mp3, так как сырой webm/opus от ютуба иногда 
            // намертво вешает OggDemuxer в либе discordjs/voice.
            const args = ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--no-video', '--no-playlist', '--js-runtimes', 'node', '-o', outputPathPattern];
            fs.access('cookies.txt', fs.constants.F_OK, (err) => {
                if (!err) args.push('--cookies', 'cookies.txt');
                args.push('--', url); // Безопасная передача URL как позиционного аргумента
                const ytDlp = spawn('yt-dlp', args);
                let errorData = '';
                ytDlp.stderr.on('data', chunk => errorData += chunk.toString());
                ytDlp.on('error', reject);
                ytDlp.on('close', code => {
                    if (code === 0) resolve();
                    else reject(new Error(`yt-dlp exited with code ${code}. Error: ${errorData.trim() || 'Unknown'}`));
                });
            });
        });
    }

    downloadDirectFile(url, outputPath) {
        return new Promise((resolve, reject) => {
            this.fetchAudioStream(url).then(response => {
                const fileStream = fs.createWriteStream(outputPath);
                response.pipe(fileStream);
                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve();
                });
                fileStream.on('error', error => {
                    fsPromises.unlink(outputPath).catch(()=>{});
                    reject(error);
                });
            }).catch(reject);
        });
    }

    fetchAudioStream(url, redirectCount = 0) {
        return new Promise((resolve, reject) => {
            if (redirectCount > 5) return reject(new Error("Too many redirects"));
            try {
                const parsedUrl = new URL(url);
                const client = parsedUrl.protocol === 'https:' ? https : http;
                client.get(parsedUrl.href, (response) => {
                    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                        const redirectUrl = new URL(response.headers.location, parsedUrl.href).href;
                        return resolve(this.fetchAudioStream(redirectUrl, redirectCount + 1));
                    }
                    if (response.statusCode !== 200) {
                        return reject(new Error(`Status code: ${response.statusCode}`));
                    }
                    resolve(response);
                }).on('error', reject);
            } catch (err) {
                reject(err);
            }
        });
    }

    static async fetchTrackTitle(url) {
        return new Promise((resolve) => {
            const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
            const isSoundcloud = url.includes('soundcloud.com');
            if (isYoutube || isSoundcloud) {
                const args = ['--print', 'title', '--no-playlist', '--js-runtimes', 'node'];
                fs.access('cookies.txt', fs.constants.F_OK, (err) => {
                    if (!err) args.push('--cookies', 'cookies.txt');
                    args.push('--', url); // Защита от флаговых инъекций
                    const ytDlp = spawn('yt-dlp', args);
                    let titleData = '';
                    ytDlp.stdout.on('data', chunk => titleData += chunk.toString());
                    ytDlp.on('close', code => resolve(code === 0 && titleData.trim() ? titleData.trim() : url));
                    ytDlp.on('error', () => resolve(url));
                });
            } else {
                try {
                    const parsedUrl = new URL(url);
                    const pathParts = parsedUrl.pathname.split('/');
                    resolve(decodeURIComponent(pathParts[pathParts.length - 1]) || url);
                } catch {
                    resolve(url);
                }
            }
        });
    }
}

module.exports = GuildSession;
