const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const { logError, logInfo } = require('./logger');
const config = require('../config');

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

    static async fetch(url, redirectCount = 0) {
        if (redirectCount > config.security.maxRedirects) {
            throw new Error(`Превышен лимит редиректов (${config.security.maxRedirects})`);
        }

        const parsedUrl = new URL(url);
        
        await this.resolveAndValidate(parsedUrl.hostname);

        return new Promise((resolve, reject) => {
            const client = parsedUrl.protocol === 'https:' ? https : http;
            const timeoutMs = config.timeouts.httpDownloadTimeoutMs;

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
                        
                        const redirectedResponse = await this.fetch(redirectUrl, redirectCount + 1);
                        resolve(redirectedResponse);
                    } catch (error) {
                        reject(error);
                    }
                    return;
                }

                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP статус: ${response.statusCode}`));
                    return;
                }

                const contentType = response.headers['content-type'] || '';
                const isValidMime = config.security.allowedMimeTypes.some(mime => 
                    contentType.toLowerCase().includes(mime)
                );

                if (!isValidMime) {
                    logError(`Invalid Content-Type: ${contentType} for ${parsedUrl.href}`);
                }

                resolve(response);
            });

            request.on('error', (error) => {
                reject(error);
            });

            request.on('timeout', () => {
                request.destroy();
                reject(new Error(`Timeout при скачивании файла (${timeoutMs}ms)`));
            });
        });
    }

    static async download(url, outputPath) {
        const fs = require('fs');
        const fsPromises = require('fs/promises');

        const response = await this.fetch(url);
        
        return new Promise((resolve, reject) => {
            const fileStream = fs.createWriteStream(outputPath);
            let downloadedBytes = 0;

            response.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (downloadedBytes > config.security.maxFileSizeBytes) {
                    response.destroy();
                    fileStream.close();
                    fsPromises.unlink(outputPath).catch(() => {});
                    reject(new Error(`Размер файла превышает лимит ${Math.floor(config.security.maxFileSizeBytes / 1024 / 1024)} МБ`));
                }
            });

            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });

            fileStream.on('error', (error) => {
                fsPromises.unlink(outputPath).catch(() => {});
                reject(error);
            });
        });
    }
}

module.exports = SafeHttpClient;
