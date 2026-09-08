const { spawn } = require('child_process');
const fs = require('fs');
const config = require('../config');
const { logError, logInfo } = require('./logger');

class YtDlpClient {
    static createStreamJob(url) {
        return new Promise((resolve, reject) => {
            const args = ['-f', 'bestaudio/best', '--no-playlist', '-o', '-'];
            
            fs.access('cookies.txt', fs.constants.F_OK, (err) => {
                if (!err) args.push('--cookies', 'cookies.txt');
                args.push('--', url);
                
                const ytDlp = spawn('yt-dlp', args);
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

    static downloadFile(url, outputPathPattern) {
        return new Promise((resolve, reject) => {
            const args = [
                '-f', 'bestaudio/best',
                '-x',
                '--audio-format', 'mp3',
                '--no-video',
                '--no-playlist',
                '-o', outputPathPattern
            ];
            
            fs.access('cookies.txt', fs.constants.F_OK, (err) => {
                if (!err) args.push('--cookies', 'cookies.txt');
                args.push('--', url);
                
                const ytDlp = spawn('yt-dlp', args);
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
                        
                        if (code === 0) {
                            resolve();
                        } else {
                            reject(new Error(`yt-dlp завершился с кодом ${code}. Ошибка: ${errorData.trim() || 'Unknown'}`));
                        }
                    }
                });
            });
        });
    }

    static async fetchTitle(url) {
        return new Promise((resolve) => {
            const args = ['--print', 'title', '--no-playlist'];
            
            fs.access('cookies.txt', fs.constants.F_OK, (err) => {
                if (!err) args.push('--cookies', 'cookies.txt');
                args.push('--', url);
                
                const ytDlp = spawn('yt-dlp', args);
                let titleData = '';
                
                const timeout = setTimeout(() => {
                    ytDlp.kill('SIGTERM');
                    resolve(url);
                }, 15000);

                ytDlp.stdout.on('data', (chunk) => {
                    titleData += chunk.toString();
                });

                ytDlp.on('close', (code) => {
                    clearTimeout(timeout);
                    resolve(code === 0 && titleData.trim() ? titleData.trim() : url);
                });

                ytDlp.on('error', () => {
                    clearTimeout(timeout);
                    resolve(url);
                });
            });
        });
    }
}

module.exports = YtDlpClient;
