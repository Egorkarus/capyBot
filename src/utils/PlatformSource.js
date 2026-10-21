// Единый список платформ, для которых метаданные и скачивание идут через yt-dlp.
// Сравнение строгое: домен или поддомен, иначе `evilyoutube.com` считался бы платформой.
const PLATFORM_HOSTS = ['youtube.com', 'youtu.be', 'soundcloud.com', 'twitch.tv'];

function isPlatformHost(hostname) {
    if (!hostname || typeof hostname !== 'string') return false;
    const normalizedHost = hostname.toLowerCase();
    return PLATFORM_HOSTS.some(domain =>
        normalizedHost === domain || normalizedHost.endsWith('.' + domain)
    );
}

function isPlatformUrl(url) {
    try {
        return isPlatformHost(new URL(url).hostname);
    } catch {
        return false;
    }
}

module.exports = { PLATFORM_HOSTS, isPlatformHost, isPlatformUrl };
