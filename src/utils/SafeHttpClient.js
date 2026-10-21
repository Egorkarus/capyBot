const https = require('https');
const http = require('http');
const fs = require('fs');
const fsPromises = require('fs/promises');
const dns = require('dns').promises;
const { once } = require('node:events');
const { logInfo, logWarn } = require('./logger');
const config = require('../config');

function createAbortError() {
    const error = new Error('Загрузка отменена');
    error.code = 'ABORTED';
    return error;
}

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${Math.floor(bytes / 1024)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function isAllowedMimeType(contentType) {
    // Сравниваем тип целиком (type/subtype): includes() пропускал бы audio/mpeg4
    // на разрешении audio/mpeg. Параметры после ';' игнорируются.
    const [mediaType] = contentType.toLowerCase().split(';');
    const normalizedType = mediaType.trim();
    return config.security.allowedMimeTypes.some(mime => normalizedType === mime.toLowerCase());
}

async function removeOutputFile(outputPath) {
    try {
        await fsPromises.rm(outputPath, { force: true });
    } catch (error) {
        logWarn(`Не удалось удалить файл ${outputPath}: ${error.message}`);
    }
}

async function waitForStreamClose(stream) {
    if (stream.closed) return;

    try {
        await once(stream, 'close');
        return;
    } catch {
        // events.once отклоняется на 'error'; 'close' приходит следом (autoDestroy).
    }

    if (!stream.closed) await new Promise(resolve => stream.once('close', resolve));
}

class SafeHttpClient {
    static async isIpAddressBlocked(ip) {
        const parts = ip.split('.');
        
        if (parts.length !== 4) {
            const ipv6Patterns = [
                /^::1$/,
                /^fe80:/i,
                /^fc00:/i,
                /^fd00:/i,
                /^ff00:/i
            ];
            return ipv6Patterns.some(pattern => pattern.test(ip));
        }

        const [a, b, c, d] = parts.map(Number);

        if (a === 127) return true;
        if (a === 10) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 169 && b === 254) return true;
        if (a === 0) return true;
        if (a >= 224) return true;

        return false;
    }

    static async resolveAndValidate(hostname) {
        try {
            const addresses = await dns.resolve4(hostname);
            
            for (const ip of addresses) {
                if (await this.isIpAddressBlocked(ip)) {
                    throw new Error(`Resolved IP ${ip} for ${hostname} is blocked (private/loopback/reserved range)`);
                }
            }

            return addresses[0];
        } catch (error) {
            if (error.code === 'ENOTFOUND') {
                throw new Error(`Cannot resolve hostname: ${hostname}`);
            }
            throw error;
        }
    }

    static async fetch(url, redirectCount = 0, options = {}) {
        if (redirectCount > config.security.maxRedirects) {
            throw new Error(`Превышен лимит редиректов (${config.security.maxRedirects})`);
        }

        const { signal } = options;
        if (signal && signal.aborted) {
            throw createAbortError();
        }

        const parsedUrl = new URL(url);

        await this.resolveAndValidate(parsedUrl.hostname);

        // DNS мог занять заметное время: проверяем отмену ещё раз перед сетевым запросом.
        if (signal && signal.aborted) {
            throw createAbortError();
        }

        const maxBytes = options.maxBytes ?? config.limits.maxDownloadBytes;

        return new Promise((resolve, reject) => {
            const client = parsedUrl.protocol === 'https:' ? https : http;
            const timeoutMs = config.timeouts.httpDownloadTimeoutMs;
            let isSettled = false;

            const settle = (handler, value) => {
                if (isSettled) return;
                isSettled = true;
                if (signal) signal.removeEventListener('abort', onAbort);
                handler(value);
            };

            const rejectResponse = (response, error) => {
                response.destroy();
                settle(reject, error);
            };

            const onAbort = () => {
                request.destroy();
                settle(reject, createAbortError());
            };

            const request = client.get(parsedUrl.href, {
                timeout: timeoutMs,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; CapyBot/1.0)'
                }
            }, async (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    try {
                        const redirectUrl = new URL(response.headers.location, parsedUrl.href).href;
                        logInfo(`Redirect ${redirectCount + 1}: ${parsedUrl.href} -> ${redirectUrl}`);

                        // Тело редиректа не нужно: освобождаем сокет.
                        response.resume();

                        const redirectedResponse = await this.fetch(redirectUrl, redirectCount + 1, options);
                        settle(resolve, redirectedResponse);
                    } catch (error) {
                        settle(reject, error);
                    }
                    return;
                }

                if (response.statusCode !== 200) {
                    rejectResponse(response, new Error(`HTTP статус: ${response.statusCode}`));
                    return;
                }

                const contentLength = Number(response.headers['content-length']);
                if (Number.isFinite(contentLength) && contentLength > maxBytes) {
                    rejectResponse(response, new Error(
                        `Размер файла превышает лимит ${formatFileSize(maxBytes)} (Content-Length: ${contentLength})`
                    ));
                    return;
                }

                const contentType = response.headers['content-type'];
                if (contentType && !isAllowedMimeType(contentType)) {
                    rejectResponse(response, new Error(`Недопустимый Content-Type: ${contentType}`));
                    return;
                }

                settle(resolve, response);
            });

            request.on('error', (error) => {
                settle(reject, error);
            });

            request.on('timeout', () => {
                request.destroy();
                settle(reject, new Error(`Timeout при скачивании файла (${timeoutMs}ms)`));
            });

            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    static async download(url, outputPath, options = {}) {
        const response = await this.fetch(url, 0, options);

        return this.writeResponseToFile(response, outputPath, {
            maxBytes: options.maxBytes,
            signal: options.signal
        });
    }

    static async writeResponseToFile(readable, outputPath, { maxBytes = config.limits.maxDownloadBytes, signal } = {}) {
        if (signal && signal.aborted) {
            readable.destroy();
            await removeOutputFile(outputPath);
            throw createAbortError();
        }

        return new Promise((resolve, reject) => {
            const fileStream = fs.createWriteStream(outputPath);
            let downloadedBytes = 0;
            let isSettled = false;
            let isEnded = false;

            const onAbort = () => {
                fail(createAbortError());
            };

            const onData = (chunk) => {
                downloadedBytes += chunk.length;
                if (downloadedBytes > maxBytes) {
                    fail(new Error(`Размер файла превышает лимит ${formatFileSize(maxBytes)}`));
                }
            };

            const onReadableEnd = () => {
                isEnded = true;
            };

            const onReadableError = (error) => {
                fail(error);
            };

            const onReadableAborted = () => {
                fail(new Error('Соединение прервано при скачивании файла'));
            };

            const onReadableClose = () => {
                // close без end — поток оборвался, а не закончился штатно.
                if (!isEnded) fail(new Error('Соединение закрыто до завершения загрузки'));
            };

            const onFileError = (error) => {
                fail(error);
            };

            const removeListeners = () => {
                if (signal) signal.removeEventListener('abort', onAbort);
                readable.removeListener('data', onData);
                readable.removeListener('end', onReadableEnd);
                readable.removeListener('error', onReadableError);
                readable.removeListener('aborted', onReadableAborted);
                readable.removeListener('close', onReadableClose);
                // fileStream 'error' остаётся: destroy() может дать ERR_STREAM_DESTROYED
                // уже после reject/resolve, и без слушателя процесс упадёт.
            };

            const discardFile = async () => {
                readable.unpipe(fileStream);
                if (!readable.destroyed) readable.destroy();

                // На Windows открытый файл не удалить: ждём реального закрытия дескриптора.
                fileStream.destroy();
                await waitForStreamClose(fileStream);
                await removeOutputFile(outputPath);
            };

            // Контракт: reject приходит только после удаления файла с диска.
            const fail = async (error) => {
                if (isSettled) return;
                isSettled = true;
                removeListeners();
                await discardFile();
                reject(error);
            };

            const onFinish = () => {
                if (isSettled) return;
                isSettled = true;
                removeListeners();
                resolve();
            };

            if (signal) signal.addEventListener('abort', onAbort, { once: true });

            readable.on('error', onReadableError);
            readable.on('aborted', onReadableAborted);
            readable.on('close', onReadableClose);
            readable.on('end', onReadableEnd);
            readable.on('data', onData);

            fileStream.on('error', onFileError);
            fileStream.on('finish', onFinish);

            readable.pipe(fileStream);
        });
    }
}

module.exports = SafeHttpClient;
