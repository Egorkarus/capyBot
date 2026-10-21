const { spawn } = require('child_process');
const { once } = require('events');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const config = require('../config');
const { logError, logWarn } = require('./logger');

// Предохранитель на ожидание 'close' перед удалением частичных файлов:
// на Windows дескриптор может освобождаться с задержкой.
const CLEANUP_CLOSE_TIMEOUT_MS = 3000;

// Путь к cookies.txt и его наличие вычисляем один раз при загрузке модуля:
// раньше на каждый вызов yt-dlp выполнялось отдельное fs.access.
const COOKIES_PATH = path.join(__dirname, '..', '..', 'cookies.txt');
const USE_COOKIES = fs.existsSync(COOKIES_PATH);

const INFO_PRINT_TEMPLATE = '%(title)s\t%(duration)s\t%(is_live)s\t%(live_status)s';

function buildYtDlpArgs(baseArgs, url) {
    return [...baseArgs, '--js-runtimes', `node:${process.execPath}`, '--', url];
}

function createAbortError() {
    const error = new Error('yt-dlp process aborted');
    error.code = 'ABORTED';
    return error;
}

function killProcessTree(child) {
    if (!child || child.exitCode !== null) return;

    if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('error', error => logError('Failed to kill yt-dlp process tree', error));
        return;
    }

    child.kill('SIGTERM');
}

function getCookiesPath() {
    return USE_COOKIES ? COOKIES_PATH : null;
}

/**
 * Удаляет файл, повторяя попытку при EPERM/EBUSY (Windows держит дескриптор
 * ещё некоторое время после завершения процесса). Не бросает исключений.
 */
async function removeFileWithRetries(filePath) {
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
 * Разбирает вывод `yt-dlp --print` с шаблоном INFO_PRINT_TEMPLATE.
 * @param {string} text
 * @returns {{title: string|null, durationMs: number|null, isLive: boolean}|null}
 *   null, если вывода нет или он не соответствует шаблону (вызывающий подставляет URL).
 */
function parseInfoOutput(text) {
    if (!text || typeof text !== 'string') return null;

    const line = text.split(/\r?\n/).find(entry => entry.trim().length > 0);
    if (!line) return null;

    // Название трека может содержать табуляцию, поэтому разбираем строку с конца:
    // последние три поля шаблона (duration, is_live, live_status) всегда справа.
    const parts = line.split('\t');
    if (parts.length < 3) return null;

    const rawLiveStatus = parts.pop();
    const rawIsLive = parts.pop();
    const rawDuration = parts.pop();
    const rawTitle = parts.join('\t');
    const title = rawTitle && rawTitle.trim() !== '' && rawTitle !== 'NA' ? rawTitle.trim() : null;

    const durationValue = rawDuration.trim();
    const durationSeconds = durationValue === '' || durationValue === 'NA' ? null : Number(durationValue);
    const durationMs = durationSeconds != null && Number.isFinite(durationSeconds)
        ? Math.round(durationSeconds * 1000)
        : null;

    const isLive = rawLiveStatus.trim() === 'is_live'
        || ['true', '1', 'yes'].includes(rawIsLive.trim().toLowerCase());

    return { title, durationMs, isLive };
}

/**
 * Классифицирует неуспешное завершение yt-dlp.
 * Код 101 больше не считается признаком превышения длительности: его может вернуть
 * любая ошибка, поэтому смотрим только на текст фильтра.
 */
function classifyDownloadFailure(code, stderr) {
    if (!code) return null;
    const errorText = String(stderr || '');
    if (errorText.includes('does not pass filter')) return 'TOO_LONG';
    return null;
}

/**
 * Извлекает реальную причину сбоя yt-dlp.
 * Предупреждения (например, об устаревшей версии) не должны скрывать ошибку,
 * которая может быть в stdout или в более ранней строке stderr.
 * @param {string} stderr
 * @param {string} stdout
 * @returns {string} одна строка с причиной, не длиннее 500 символов
 */
function extractFailureDetail(stderr, stdout) {
    const toLines = (text) => String(text || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0);

    const stderrLines = toLines(stderr);
    const stdoutLines = toLines(stdout);
    const truncate = (line) => (line.length > 500 ? line.slice(0, 500) : line);

    const errorLines = stderrLines.filter(line => line.includes('ERROR:'));
    if (errorLines.length > 0) return truncate(errorLines[errorLines.length - 1]);

    const nonWarningLine = stderrLines.filter(line => !line.startsWith('WARNING:')).pop();
    if (nonWarningLine) return truncate(nonWarningLine);

    if (stdoutLines.length > 0) return truncate(stdoutLines[stdoutLines.length - 1]);

    if (stderrLines.length > 0) return truncate(stderrLines[stderrLines.length - 1]);

    return 'Unknown';
}

class YtDlpClient {
    static buildInfoArgs(url, options = {}) {
        const args = ['--no-playlist', '--no-warnings', '--print', INFO_PRINT_TEMPLATE];
        if (options.cookiesPath) args.push('--cookies', options.cookiesPath);
        return buildYtDlpArgs(args, url);
    }

    static buildDownloadArgs(url, options = {}) {
        const outputPathPattern = options.outputPathPattern || '%(title)s.%(ext)s';
        // `audio_channels` — поле формата (не CLI-опция): сначала пробуем стерео,
        // иначе лучший доступный.
        const args = [
            '-f', 'bestaudio[audio_channels=2]/bestaudio',
            '-x',
            '--audio-format', 'opus',
            '--no-video',
            '--no-playlist',
            '-o', outputPathPattern
        ];

        if (options.maxDurationMs != null) {
            args.push('--match-filter', `duration < ${Math.ceil(options.maxDurationMs / 1000)}`);
        }
        if (options.cookiesPath) args.push('--cookies', options.cookiesPath);

        return buildYtDlpArgs(args, url);
    }

    static createStreamJob(url, options = {}) {
        const { signal } = options;

        if (signal && signal.aborted) {
            return Promise.reject(createAbortError());
        }

        return new Promise((resolve, reject) => {
            const args = ['-f', 'bestaudio/best', '--no-playlist', '-o', '-'];
            if (USE_COOKIES) args.push('--cookies', COOKIES_PATH);

            const ytDlp = spawn('yt-dlp', buildYtDlpArgs(args, url));
            let stderrData = '';
            let isSettled = false;
            let timeout = null;

            const onAbort = () => {
                if (isSettled) return;
                killProcessTree(ytDlp);
                if (ytDlp.stdout) ytDlp.stdout.destroy();
                settle(reject, createAbortError());
            };

            const settle = (handler, value) => {
                if (isSettled) return;
                isSettled = true;
                clearTimeout(timeout);
                if (signal) signal.removeEventListener('abort', onAbort);
                handler(value);
            };

            if (signal) signal.addEventListener('abort', onAbort, { once: true });

            timeout = setTimeout(() => {
                killProcessTree(ytDlp);
                settle(reject, new Error(`yt-dlp stream timeout (${config.timeouts.ytDlpTimeoutMs}ms)`));
            }, config.timeouts.ytDlpTimeoutMs);

            ytDlp.stderr.on('data', (data) => {
                const line = data.toString();
                stderrData += line;

                if (stderrData.length > 50000) {
                    stderrData = stderrData.slice(-50000);
                }

                if (line.includes('ERROR:')) {
                    logError(`yt-dlp error: ${line.trim()}`);
                }
            });

            ytDlp.on('error', (error) => {
                settle(reject, error);
            });

            ytDlp.on('spawn', () => {
                if (isSettled) {
                    killProcessTree(ytDlp);
                    return;
                }

                clearTimeout(timeout);

                const job = {
                    stream: ytDlp.stdout,
                    process: ytDlp,
                    stop: async () => {
                        if (ytDlp.exitCode !== null) return;
                        killProcessTree(ytDlp);

                        await Promise.race([
                            job.completed,
                            new Promise(res => setTimeout(res, 3000))
                        ]);
                    },
                    completed: new Promise((res) => {
                        ytDlp.once('exit', (code) => {
                            res({ code, stderr: stderrData });
                        });
                    })
                };

                settle(resolve, job);
            });
        });
    }

    static downloadFile(url, outputPathPattern, maxDurationMs = null, options = {}) {
        const { signal } = options;

        if (signal && signal.aborted) {
            return Promise.reject(createAbortError());
        }

        const outputDir = path.dirname(outputPathPattern);
        const filePrefix = path.basename(outputPathPattern).split('.%(')[0];

        const cleanupPartialFiles = async () => {
            try {
                const entries = await fsPromises.readdir(outputDir);
                const partialFiles = entries.filter(name => name.startsWith(filePrefix));
                await Promise.all(partialFiles.map(name =>
                    removeFileWithRetries(path.join(outputDir, name))
                ));
            } catch (error) {
                logError('Failed to cleanup partial yt-dlp files', error);
            }
        };

        return new Promise((resolve, reject) => {
            const args = YtDlpClient.buildDownloadArgs(url, {
                outputPathPattern,
                maxDurationMs,
                cookiesPath: getCookiesPath()
            });

            const ytDlp = spawn('yt-dlp', args);
            let stderrData = '';
            let stdoutData = '';
            let lastStderrLine = '';
            let isSettled = false;
            let isStopping = false;
            let abortRequested = false;
            let inactivityTimer = null;
            let hardTimer = null;

            // На Windows удаление упадёт, пока процесс держит дескриптор,
            // поэтому перед чисткой ждём 'close' с предохранителем по времени.
            const processClosed = once(ytDlp, 'close').then(() => {}, () => {});

            const waitForProcessClose = async () => {
                if (ytDlp.exitCode !== null || ytDlp.signalCode !== null) return;

                let guardTimer = null;
                const guard = new Promise(resolveGuard => {
                    guardTimer = setTimeout(resolveGuard, CLEANUP_CLOSE_TIMEOUT_MS);
                });

                await Promise.race([processClosed, guard]);
                clearTimeout(guardTimer);
            };

            const clearTimers = () => {
                clearTimeout(inactivityTimer);
                clearTimeout(hardTimer);
            };

            const settle = (handler, value) => {
                if (isSettled) return;
                isSettled = true;
                clearTimers();
                if (signal) signal.removeEventListener('abort', onAbort);
                handler(value);
            };

            // Таймауты и abort: сначала гасим процесс, дожидаемся закрытия
            // и только потом удаляем частичные файлы, о которых GuildSession не знает.
            const stopWithError = async (error) => {
                if (isSettled || isStopping) return;
                isStopping = true;
                abortRequested = true;
                killProcessTree(ytDlp);
                await waitForProcessClose();
                await cleanupPartialFiles();
                settle(reject, error);
            };

            const onAbort = () => {
                stopWithError(createAbortError())
                    .catch(cleanupError => logError('Failed to abort yt-dlp download', cleanupError));
            };

            const resetInactivityTimer = () => {
                clearTimeout(inactivityTimer);
                inactivityTimer = setTimeout(() => {
                    const phaseHint = lastStderrLine
                        ? `, последняя строка вывода: ${lastStderrLine.length > 200 ? `${lastStderrLine.slice(0, 197)}...` : lastStderrLine}`
                        : '';
                    stopWithError(new Error(
                        `yt-dlp download timeout (${config.timeouts.ytDlpTimeoutMs}ms без активности${phaseHint})`
                    )).catch(error => logError('Failed to stop yt-dlp download on timeout', error));
                }, config.timeouts.ytDlpTimeoutMs);
            };

            if (signal) signal.addEventListener('abort', onAbort, { once: true });

            resetInactivityTimer();
            hardTimer = setTimeout(() => {
                stopWithError(new Error(`yt-dlp download hard timeout (${config.timeouts.downloadHardTimeoutMs}ms)`))
                    .catch(error => logError('Failed to stop yt-dlp download on hard timeout', error));
            }, config.timeouts.downloadHardTimeoutMs);

            // Активность — любые данные любого из потоков. Прогресс загрузки
            // yt-dlp пишет в stdout, ошибки и фазы — в stderr.
            // Хвост stdout нужен для диагностики: иногда причина сбоя только там.
            ytDlp.stdout.on('data', (chunk) => {
                stdoutData += chunk.toString();
                if (stdoutData.length > 2000) {
                    stdoutData = stdoutData.slice(-2000);
                }
                resetInactivityTimer();
            });

            ytDlp.stderr.on('data', (chunk) => {
                const text = chunk.toString();
                stderrData += text;
                if (stderrData.length > 10000) {
                    stderrData = stderrData.slice(-10000);
                }

                const lines = text.split(/\r?\n/).filter(entry => entry.trim().length > 0);
                if (lines.length > 0) lastStderrLine = lines[lines.length - 1].trim();

                resetInactivityTimer();
            });

            ytDlp.on('error', (error) => {
                if (abortRequested) return;
                settle(reject, error);
            });

            ytDlp.on('close', async (code) => {
                if (isSettled || abortRequested) return;

                if (code === 0) {
                    settle(resolve);
                    return;
                }

                // Процесс уже закрылся, поэтому удаление безопасно и без ожидания.
                await cleanupPartialFiles();
                if (isSettled) return;

                if (classifyDownloadFailure(code, stderrData) === 'TOO_LONG') {
                    settle(reject, new Error('TOO_LONG'));
                    return;
                }

                const detail = extractFailureDetail(stderrData, stdoutData);
                const outdatedVersionHint = detail.includes('is older than 90 days')
                    ? ' (похоже, в образе устаревший yt-dlp: пересоберите образ — docker compose up -d --build)'
                    : '';
                settle(reject, new Error(`yt-dlp завершился с кодом ${code}. ${detail}${outdatedVersionHint}`));
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
    static fetchInfo(url) {
        return new Promise((resolve) => {
            const fallback = { title: url, durationMs: null, isLive: false };
            const args = YtDlpClient.buildInfoArgs(url, { cookiesPath: getCookiesPath() });

            const ytDlp = spawn('yt-dlp', args);
            let stdoutData = '';
            let isSettled = false;
            let timeout = null;

            const settle = (result) => {
                if (isSettled) return;
                isSettled = true;
                clearTimeout(timeout);
                resolve(result);
            };

            timeout = setTimeout(() => {
                killProcessTree(ytDlp);
                settle(fallback);
            }, config.timeouts.infoFetchTimeoutMs);

            ytDlp.stdout.on('data', (chunk) => {
                stdoutData += chunk.toString();
            });

            ytDlp.on('close', (code) => {
                if (code !== 0) {
                    settle(fallback);
                    return;
                }

                const parsed = parseInfoOutput(stdoutData);
                if (!parsed) {
                    settle(fallback);
                    return;
                }

                settle({
                    title: parsed.title || url,
                    durationMs: parsed.durationMs,
                    isLive: parsed.isLive
                });
            });

            ytDlp.on('error', () => {
                settle(fallback);
            });
        });
    }
}

module.exports = YtDlpClient;
module.exports.parseInfoOutput = parseInfoOutput;
module.exports.classifyDownloadFailure = classifyDownloadFailure;
module.exports.extractFailureDetail = extractFailureDetail;
