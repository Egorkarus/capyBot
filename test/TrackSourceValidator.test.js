const { test } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const TrackSourceValidator = require('../src/utils/TrackSourceValidator');

test('http:// отклоняется, https:// с аудио-расширением принимается', () => {
    assert.equal(TrackSourceValidator.validate('http://example.com/a.mp3').valid, false);

    const directResult = TrackSourceValidator.validate('https://example.com/a.mp3');
    assert.equal(directResult.valid, true);
    assert.equal(directResult.normalized.kind, 'direct');
});

test('https:// без разрешённого расширения и неразрешённым доменом отклоняется', () => {
    assert.equal(TrackSourceValidator.validate('https://example.com/a.txt').valid, false);
    assert.equal(TrackSourceValidator.validate('https://example.com/download').valid, false);
});

test('ссылки платформ принимаются с kind=platform', () => {
    const platformUrls = [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://youtu.be/dQw4w9WgXcQ',
        'https://soundcloud.com/artist/track',
        'https://www.twitch.tv/videos/123456'
    ];

    for (const url of platformUrls) {
        const result = TrackSourceValidator.validate(url);
        assert.equal(result.valid, true, url);
        assert.equal(result.normalized.kind, 'platform', url);
    }
});

test('evilyoutube.com с mp3 валиден по расширению, но не является платформой', () => {
    const result = TrackSourceValidator.validate('https://evilyoutube.com/a.mp3');

    assert.equal(result.valid, true);
    assert.notEqual(result.normalized.kind, 'platform');
    assert.equal(result.normalized.kind, 'direct');
});

test('validateAttachment проверяет расширение, размер и наличие url', () => {
    const validAttachment = TrackSourceValidator.validateAttachment({
        name: 'track.mp3',
        url: 'https://cdn.example.com/track.mp3',
        size: 1024
    });
    assert.equal(validAttachment.valid, true);
    assert.equal(validAttachment.normalized.kind, 'attachment');

    assert.equal(TrackSourceValidator.validateAttachment({
        name: 'malware.exe',
        url: 'https://cdn.example.com/malware.exe',
        size: 1024
    }).valid, false);

    assert.equal(TrackSourceValidator.validateAttachment({
        name: 'huge.mp3',
        url: 'https://cdn.example.com/huge.mp3',
        size: config.security.maxFileSizeBytes + 1
    }).valid, false);

    assert.equal(TrackSourceValidator.validateAttachment({
        name: 'track.mp3',
        size: 1024
    }).valid, false);

    assert.equal(TrackSourceValidator.validateAttachment(null).valid, false);
});
