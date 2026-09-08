const { spawn } = require('child_process');
const fs = require('fs');
const config = require('../config');
const { logError, logInfo } = require('./logger');

function buildYtDlpArgs(baseArgs, url) {
    return [...baseArgs, '--js-runtimes', `node:${process.execPath}`, '--', url];
}

function spawnYtDlp(baseArgs, url) {
    return spawn('yt-dlp', buildYtDlpArgs(baseArgs, url));
}

class YtDlpClient {
    static createStreamJob(url) {
        return new Promise((resolve, reject) => {
            fs.access('cookies.txt', fs.constants.F_OK, (err) => {
                const args = ['-f', 'bestaudio/best', '--no-playlist', '-o', '-'];
                if (!err) args.push('--cookies', 'cookies.txt');

                const ytDlp = spawnYtDlp(args, url);
                let stderrData = '';
                let isResolved = false;
                
                const timeout = setTimeout(() => {
                    if (!isResolved) {
                        isResolved = true;
                        ytDlp.kill('SIGTERM');
                        reject(new Error(`yt-dlp stream timeout (${config.timeouts.ytDlpTimeoutMs}ms)`));
                    }
                }, config.timeouts.ytDlpTimeoutMs);

                ytDlp.stderr.on('data', (data) => {
                    const line = data.toString();
                    stderrData += line;
                    
                    if (stderrData.length > 50000) {
                        stderrData = stderrData.slice(-50000);
                    }
                    
                    if (line.includes('ERROR:')) {
                        logError(`yt-dlp error: ${line}`);
                    }
                });

                ytDlp.on('error', (error) => {
                    if (!isResolved) {
                        isResolved = true;
                        clearTimeout(timeout);
                        reject(error);
                    }
                });

                ytDlp.on('spawn', () => {
                    if (!isResolved) {
                        isResolved = true;
                        clearTimeout(timeout);
                        
                        const job = {
                            stream: ytDlp.stdout,
                            process: ytDlp,
                            stop: async () => {
                                if (!ytDlp.killed) {
                                    ytDlp.kill('SIGTERM');
                                    
                                    await new Promise((res) => {
                                        const killTimeout = setTimeout(() => {
                                            if (!ytDlp.killed) {
                                                ytDlp.kill('SIGKILL');
                                            }
                                            res();
                                        }, 3000);
                                        
                                        ytDlp.once('exit', () => {
                                            clearTimeout(killTimeout);
                                            res();
                                        });
                                    });
                                }
                            },
                            completed: new Promise((res) => {
                                ytDlp.once('exit', (code) => {
                                    res({ code, stderr: stderrData });
                                });
                            })
                        };
                        
                        resolve(job);
                    }
                });
            });
        });
    }

    static downloadFile(url, outputPathPattern, maxDurationMs = null) {
        return new Promise((resolve, reject) => {
            const args = [
                '-f', 'bestaudio/best',
                '-x',
                '--audio-format', 'mp3',
                '--no-video',
                '--no-playlist',
                '--no-progress',
                '-o', outputPathPattern
            ];

            if (maxDurationMs != null) {
                args.push('--match-filter', `duration < ${Math.ceil(maxDurationMs / 1000)}`);
            }

            fs.access('cookies.txt', fs.constants.F_OK, (err) => {
                if (!err) args.push('--cookies', 'cookies.txt');

                const ytDlp = spawnYtDlp(args, url);
                let errorData = '';
                let isCompleted = false;
                
                const timeout = setTimeout(() => {
                    if (!isCompleted) {
                        isCompleted = true;
                        ytDlp.kill('SIGTERM');
                        reject(new Error(`yt-dlp download timeout (${config.timeouts.ytDlpTimeoutMs}ms)`));
                    }
                }, config.timeouts.ytDlpTimeoutMs);

                ytDlp.stderr.on('data', (chunk) => {
                    errorData += chunk.toString();
                    if (errorData.length > 10000) {
                        errorData = errorData.slice(-10000);
                    }
                });

                ytDlp.on('error', (error) => {
                    if (!isCompleted) {
                        isCompleted = true;
                        clearTimeout(timeout);
                        reject(error);
                    }
                });

                ytDlp.on('close', (code) => {
                    if (!isCompleted) {
                        isCompleted = true;
                        clearTimeout(timeout);
                        // Для файлов, отсечённых фильтром длительности, yt-dlp выходит с кодом 101.
                        if (code === 101) {
                            reject(new Error('TOO_LONG'));
                        } else if (code === 0) {
                            resolve();
                        } else {
                            reject(new Error(`yt-dlp завершился с кодом ${code}. Ошибка: ${errorData.trim() || 'Unknown'}`));
                        }
                    }
                });
            });
        });
    }

    /**
     * Получает метаданные трека (title, длительность, isLive) одним вызовом yt-dlp.
     * @param {string} url
     * @returns {Promise<{title: string, durationMs: number|null, isLive: boolean}>}
     *   При любой ошибке вернёт фолбэк с title = исходным URL, durationMs = null, isLive = false,
     *   чтобы поток не падал из-за недоступности метаданных.
     */
    static async fetchInfo(url) {
        return new Promise((resolve) => {
            fs.access('cookies.txt', fs.constants.F_OK, (err) => {
                const args = ['--dump-single-json', '--no-playlist', '--no-warnings'];
                if (!err) args.push('--cookies', 'cookies.txt');

                const ytDlp = spawnYtDlp(args, url);
                let jsonData = '';
                const timeout = setTimeout(() => {
                    ytDlp.kill('SIGTERM');
                    resolve({ title: url, durationMs: null, isLive: false });
                }, 15000);

                ytDlp.stdout.on('data', (chunk) => {
                    jsonData += chunk.toString();
                    if (jsonData.length > 50000) {
                        ytDlp.kill('SIGTERM');
                    }
                });

                ytDlp.on('close', (code) => {
                    clearTimeout(timeout);
                    if (code !== 0 || !jsonData.trim()) {
                        resolve({ title: url, durationMs: null, isLive: false });
                        return;
                    }
                    try {
                        const info = JSON.parse(jsonData);
                        const durationMs = (info.duration ?? null) != null ? Math.round(info.duration * 1000) : null;
                        // is_live или был_in_данных; в yt-dlp это info.is_live
                        resolve({
                            title: info.title || url,
                            durationMs,
                            isLive: Boolean(info.live_status === 'is_live' || info.is_live)
                        });
                    } catch (err) {
                        resolve({ title: url, durationMs: null, isLive: false });
                    }
                });

                ytDlp.on('error', () => {
                    clearTimeout(timeout);
                    resolve({ title: url, durationMs: null, isLive: false });
                });
            });
        });
    }
}

module.exports = YtDlpClient;
