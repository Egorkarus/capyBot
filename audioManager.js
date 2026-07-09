const { createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const { logInfo, logError } = require('./logger');

const guildAudioStates = new Map();

if (fs.existsSync('temp')) {
    const files = fs.readdirSync('temp');
    for (const file of files) {
        try {
            fs.unlinkSync(`temp/${file}`);
        } catch (err) {
            logError("Failed to clean up old temp file on start", err);
        }
    }
} else {
    fs.mkdirSync('temp', { recursive: true });
}

function fetchAudioStream(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) {
            reject(new Error("Too many redirects"));
            return;
        }

        try {
            const parsedUrl = new URL(url);
            const client = parsedUrl.protocol === 'https:' ? https : http;

            client.get(parsedUrl.href, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    const redirectUrl = new URL(response.headers.location, parsedUrl.href).href;
                    resolve(fetchAudioStream(redirectUrl, redirectCount + 1));
                    return;
                }

                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to fetch stream, status code: ${response.statusCode}`));
                    return;
                }

                resolve(response);
            }).on('error', (error) => {
                reject(error);
            });
        } catch (parseError) {
            reject(parseError);
        }
    });
}

function downloadDirectFile(url, outputPath) {
    return new Promise((resolve, reject) => {
        fetchAudioStream(url).then(response => {
            const fileStream = fs.createWriteStream(outputPath);
            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });

            fileStream.on('error', error => {
                fs.unlink(outputPath, () => {});
                reject(error);
            });
        }).catch(reject);
    });
}

function downloadViaYtDlp(url, outputPathPattern) {
    return new Promise((resolve, reject) => {
        const args = [
            '-f', 'bestaudio/best',
            '--no-video',
            '--no-playlist',
            '-o', outputPathPattern
        ];
        if (fs.existsSync('cookies.txt')) {
            args.push('--cookies', 'cookies.txt');
        }
        args.push(url);

        const ytDlp = spawn('yt-dlp', args);
        let errorData = '';

        ytDlp.stderr.on('data', chunk => {
            errorData += chunk.toString();
        });

        ytDlp.on('error', reject);

        ytDlp.on('close', code => {
            if (code === 0) {
                resolve();
            } else {
                const cleanedError = errorData.trim() || 'Unknown error';
                reject(new Error(`yt-dlp exited with code ${code}. Error: ${cleanedError}`));
            }
        });
    });
}

function fetchTrackTitle(url) {
    return new Promise((resolve) => {
        const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
        const isSoundcloud = url.includes('soundcloud.com');

        if (isYoutube || isSoundcloud) {
            const args = ['--print', 'title', '--no-playlist', url];
            if (fs.existsSync('cookies.txt')) {
                args.push('--cookies', 'cookies.txt');
            }
            const ytDlp = spawn('yt-dlp', args);
            let titleData = '';

            ytDlp.stdout.on('data', chunk => {
                titleData += chunk.toString();
            });

            ytDlp.on('close', code => {
                if (code === 0 && titleData.trim()) {
                    resolve(titleData.trim());
                } else {
                    resolve(url);
                }
            });

            ytDlp.on('error', () => {
                resolve(url);
            });
        } else {
            try {
                const parsedUrl = new URL(url);
                const pathParts = parsedUrl.pathname.split('/');
                const fileName = pathParts[pathParts.length - 1];
                resolve(decodeURIComponent(fileName) || url);
            } catch (err) {
                resolve(url);
            }
        }
    });
}

function createGuildAudioState(guildId, connection, textChannel) {
    const player = createAudioPlayer({
        behaviors: {
            noSubscriber: NoSubscriberBehavior.Play,
        },
    });

    const subscription = connection.subscribe(player);

    const state = {
        player,
        connection,
        textChannel,
        subscription,
        tracks: [],
        currentFilePath: null
    };

    player.on(AudioPlayerStatus.Idle, () => {
        logInfo(`Audio player idle in guild ${guildId}`);
        
        if (state.currentFilePath && fs.existsSync(state.currentFilePath)) {
            fs.unlink(state.currentFilePath, (err) => {
                if (err) logError("Failed to delete temp file on idle", err);
            });
            state.currentFilePath = null;
        }

        playNextTrack(guildId);
    });

    player.on('error', error => {
        logError(`Audio player error in guild ${guildId}`, error);
        state.textChannel.send("Эта шарманка сломалась, давай другую. 🍊🔧");

        if (state.currentFilePath && fs.existsSync(state.currentFilePath)) {
            fs.unlink(state.currentFilePath, (err) => {
                if (err) logError("Failed to delete temp file on player error", err);
            });
            state.currentFilePath = null;
        }

        playNextTrack(guildId);
    });

    guildAudioStates.set(guildId, state);
    return state;
}

function getGuildAudioState(guildId) {
    return guildAudioStates.get(guildId);
}

async function playNextTrack(guildId) {
    const state = guildAudioStates.get(guildId);
    if (!state) {
        return;
    }

    if (state.currentFilePath && fs.existsSync(state.currentFilePath)) {
        try {
            fs.unlinkSync(state.currentFilePath);
        } catch (err) {
            logError("Failed to delete previous temp file", err);
        }
        state.currentFilePath = null;
    }

    if (state.tracks.length === 0) {
        state.textChannel.send("Песни закончились. Несите следующую, иначе я усну. 🍊");
        if (state.subscription) {
            state.subscription.unsubscribe();
            state.subscription = null;
        }
        return;
    }

    const nextTrack = state.tracks.shift();
    const nextUrl = nextTrack.url;
    const nextTitle = nextTrack.title;
    const filePrefix = `track_${guildId}_${Date.now()}`;
    let tempFilePath = '';

    try {
        state.textChannel.send(`Скачиваю трек, погоди секундную стрелку... 🍊📥\n**${nextTitle}**`);
        
        const isYoutube = nextUrl.includes('youtube.com') || nextUrl.includes('youtu.be');
        const isSoundcloud = nextUrl.includes('soundcloud.com');
        if (isYoutube || isSoundcloud) {
            logInfo(`Attempting to download audio via yt-dlp from: ${nextUrl}`);
            const outputPathPattern = `temp/${filePrefix}.%(ext)s`;
            await downloadViaYtDlp(nextUrl, outputPathPattern);
            
            const files = fs.readdirSync('temp');
            const matchedFile = files.find(f => f.startsWith(filePrefix));
            if (!matchedFile) {
                throw new Error("Downloaded file not found on disk");
            }
            tempFilePath = `temp/${matchedFile}`;
            logInfo(`Successfully downloaded audio via yt-dlp to: ${tempFilePath}`);
        } else {
            logInfo(`Attempting to download direct MP3 file from: ${nextUrl}`);
            tempFilePath = `temp/${filePrefix}.mp3`;
            await downloadDirectFile(nextUrl, tempFilePath);
            logInfo(`Successfully downloaded direct MP3 file to: ${tempFilePath}`);
        }

        state.currentFilePath = tempFilePath;
        const resource = createAudioResource(tempFilePath);
        state.player.play(resource);
        logInfo(`Started playing local file ${tempFilePath} for url ${nextUrl} in guild ${guildId}`);
    } catch (error) {
        logError(`Failed to download or play resource ${nextUrl}`, error);
        state.textChannel.send(`Не могу скачать трек **${nextTitle}**, пропускаю. 🍊`);
        
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try {
                fs.unlinkSync(tempFilePath);
            } catch (err) {
                logError("Failed to delete temp file on error", err);
            }
        } else {
            try {
                const files = fs.readdirSync('temp');
                const matchedFile = files.find(f => f.startsWith(filePrefix));
                if (matchedFile) {
                    fs.unlinkSync(`temp/${matchedFile}`);
                }
            } catch (cleanupErr) {
                logError("Failed to clean up files by prefix on error", cleanupErr);
            }
        }
        state.currentFilePath = null;
        
        playNextTrack(guildId);
    }
}

function playAudio(guildId, url, title, connection, textChannel) {
    let state = guildAudioStates.get(guildId);
    if (!state) {
        state = createGuildAudioState(guildId, connection, textChannel);
    } else {
        state.connection = connection;
        state.textChannel = textChannel;
        if (!state.subscription) {
            state.subscription = connection.subscribe(state.player);
        }
    }

    state.tracks.push({ url, title });

    if (state.player.state.status === AudioPlayerStatus.Idle) {
        playNextTrack(guildId);
    }
}

function skipAudio(guildId) {
    const state = guildAudioStates.get(guildId);
    if (!state) {
        return;
    }

    state.player.stop();

    if (state.currentFilePath && fs.existsSync(state.currentFilePath)) {
        fs.unlink(state.currentFilePath, (err) => {
            if (err) logError("Failed to delete temp file on skip", err);
        });
        state.currentFilePath = null;
    }
    logInfo(`Skipped current track in guild ${guildId}`);
}

function pauseAudio(guildId) {
    const state = guildAudioStates.get(guildId);
    if (!state) {
        return;
    }

    state.player.pause();
}

function resumeAudio(guildId) {
    const state = guildAudioStates.get(guildId);
    if (!state) {
        return;
    }

    state.player.unpause();
}

function stopAudio(guildId) {
    const state = guildAudioStates.get(guildId);
    if (!state) {
        return;
    }

    state.tracks = [];
    state.player.stop();

    if (state.subscription) {
        state.subscription.unsubscribe();
        state.subscription = null;
    }

    if (state.currentFilePath && fs.existsSync(state.currentFilePath)) {
        fs.unlink(state.currentFilePath, (err) => {
            if (err) logError("Failed to delete temp file on stop", err);
        });
        state.currentFilePath = null;
    }
}

module.exports = {
    playAudio,
    skipAudio,
    pauseAudio,
    resumeAudio,
    stopAudio,
    fetchTrackTitle,
    getGuildAudioState
};
