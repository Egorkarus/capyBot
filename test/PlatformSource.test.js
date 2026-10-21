const { test } = require('node:test');
const assert = require('node:assert/strict');

const PlatformSource = require('../src/utils/PlatformSource');

test('isPlatformHost распознаёт домены платформ и их поддомены', () => {
    const platformHosts = [
        'youtube.com',
        'www.youtube.com',
        'm.youtube.com',
        'youtu.be',
        'soundcloud.com',
        'www.soundcloud.com',
        'twitch.tv',
        'www.twitch.tv'
    ];

    for (const hostname of platformHosts) {
        assert.equal(PlatformSource.isPlatformHost(hostname), true, hostname);
    }
});

test('isPlatformHost не считает платформой похожие и посторонние домены', () => {
    const foreignHosts = [
        'evilyoutube.com',
        'youtube.com.evil.tld',
        'example.com',
        'notyoutu.be',
        ''
    ];

    for (const hostname of foreignHosts) {
        assert.equal(PlatformSource.isPlatformHost(hostname), false, hostname);
    }

    assert.equal(PlatformSource.isPlatformHost(null), false);
    assert.equal(PlatformSource.isPlatformHost(undefined), false);
});

test('isPlatformUrl распознаёт ссылки четырёх платформ', () => {
    const platformUrls = [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://youtu.be/dQw4w9WgXcQ',
        'https://soundcloud.com/artist/track',
        'https://www.twitch.tv/videos/123456'
    ];

    for (const url of platformUrls) {
        assert.equal(PlatformSource.isPlatformUrl(url), true, url);
    }
});

test('isPlatformUrl отклоняет похожие домены и мусор без исключения', () => {
    const rejectedUrls = [
        'https://evilyoutube.com/a.mp3',
        'https://youtube.com.evil.tld/a.mp3',
        'https://example.com/a.mp3',
        'not a url',
        '',
        null
    ];

    for (const url of rejectedUrls) {
        assert.equal(PlatformSource.isPlatformUrl(url), false, String(url));
    }
});
