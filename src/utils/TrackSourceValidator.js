const config = require('../config');
const { logError } = require('./logger');

class TrackSourceValidator {
    static validate(url) {
        if (!url || typeof url !== 'string') {
            return { valid: false, reason: 'URL не указан или имеет неверный формат' };
        }

        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (error) {
            return { valid: false, reason: 'Некорректный формат URL' };
        }

        if (parsedUrl.protocol !== 'https:') {
            return { valid: false, reason: 'Разрешены только HTTPS-ссылки' };
        }

        const hostname = parsedUrl.hostname.toLowerCase();
        
        const isAllowedDomain = config.security.allowedDomains.some(domain => 
            hostname === domain || hostname.endsWith('.' + domain)
        );

        if (!isAllowedDomain) {
            const ext = parsedUrl.pathname.toLowerCase().split('?')[0];
            const hasAllowedExtension = config.security.allowedFileExtensions.some(allowedExt => 
                ext.endsWith(allowedExt)
            );
            
            if (!hasAllowedExtension) {
                return { 
                    valid: false, 
                    reason: `Домен ${hostname} не в белом списке, и расширение файла не разрешено` 
                };
            }
        }

        const kind = this.classifySource(parsedUrl);
        
        return {
            valid: true,
            normalized: {
                kind,
                url: parsedUrl,
                host: hostname
            }
        };
    }

    static classifySource(parsedUrl) {
        const hostname = parsedUrl.hostname.toLowerCase();
        
        if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
            return 'platform';
        }
        if (hostname.includes('soundcloud.com')) {
            return 'platform';
        }
        if (hostname.includes('twitch.tv')) {
            return 'platform';
        }
        
        const ext = parsedUrl.pathname.toLowerCase().split('?')[0];
        const hasAudioExtension = config.security.allowedFileExtensions.some(allowedExt => 
            ext.endsWith(allowedExt)
        );
        
        return hasAudioExtension ? 'direct' : 'unknown';
    }

    static validateAttachment(attachment) {
        if (!attachment || !attachment.url) {
            return { valid: false, reason: 'Вложение не содержит URL' };
        }

        const fileName = attachment.name ? attachment.name.toLowerCase() : '';
        const hasAllowedExtension = config.security.allowedFileExtensions.some(ext => 
            fileName.endsWith(ext)
        );

        if (!hasAllowedExtension) {
            return { 
                valid: false, 
                reason: `Расширение файла ${fileName} не поддерживается` 
            };
        }

        if (attachment.size && attachment.size > config.security.maxFileSizeBytes) {
            return { 
                valid: false, 
                reason: `Размер файла превышает лимит ${Math.floor(config.security.maxFileSizeBytes / 1024 / 1024)} МБ` 
            };
        }

        try {
            const parsedUrl = new URL(attachment.url);
            
            return {
                valid: true,
                normalized: {
                    kind: 'attachment',
                    url: parsedUrl,
                    host: parsedUrl.hostname.toLowerCase(),
                    fileName: attachment.name
                }
            };
        } catch (error) {
            return { valid: false, reason: 'Некорректный URL вложения' };
        }
    }
}

module.exports = TrackSourceValidator;
