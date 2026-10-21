const { test } = require('node:test');
const assert = require('node:assert/strict');

const YtDlpClient = require('../src/utils/YtDlpClient');

const SAMPLE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function getArgumentAfter(args, flag) {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
}

test('buildInfoArgs: печать метаданных, js-runtimes и url после --', () => {
    const args = YtDlpClient.buildInfoArgs(SAMPLE_URL);

    assert.ok(args.includes('--print'));
    assert.ok(args.includes('--no-playlist'));
    assert.ok(args.includes('--js-runtimes'));
    assert.equal(getArgumentAfter(args, '--js-runtimes'), `node:${process.execPath}`);
    assert.equal(args[args.length - 2], '--');
    assert.equal(args[args.length - 1], SAMPLE_URL);
    assert.equal(args.includes('--cookies'), false);
});

test('buildInfoArgs добавляет --cookies только при переданном пути', () => {
    const args = YtDlpClient.buildInfoArgs(SAMPLE_URL, { cookiesPath: 'C:\\tmp\\cookies.txt' });

    assert.equal(getArgumentAfter(args, '--cookies'), 'C:\\tmp\\cookies.txt');
});

test('buildDownloadArgs: bestaudio, mp3 и фильтр длительности', () => {
    const args = YtDlpClient.buildDownloadArgs(SAMPLE_URL, { maxDurationMs: 60000 });

    assert.equal(getArgumentAfter(args, '-f'), 'bestaudio/best');
    assert.ok(args.includes('-x'));
    assert.equal(getArgumentAfter(args, '--audio-format'), 'mp3');
    assert.equal(getArgumentAfter(args, '--match-filter'), 'duration < 60');
    assert.equal(args[args.length - 2], '--');
    assert.equal(args[args.length - 1], SAMPLE_URL);
});

test('buildDownloadArgs без maxDurationMs не добавляет --match-filter', () => {
    const args = YtDlpClient.buildDownloadArgs(SAMPLE_URL);

    assert.equal(args.includes('--match-filter'), false);
});

test('buildDownloadArgs не глушит прогресс загрузки', () => {
    const args = YtDlpClient.buildDownloadArgs(SAMPLE_URL, { maxDurationMs: 60000 });

    assert.equal(args.includes('--no-progress'), false);
});

test('parseInfoOutput разбирает обычный трек', () => {
    assert.deepEqual(
        YtDlpClient.parseInfoOutput('Title\t600\tFalse\tnot_live'),
        { title: 'Title', durationMs: 600000, isLive: false }
    );
});

test('parseInfoOutput распознаёт live-трансляцию без длительности', () => {
    const parsed = YtDlpClient.parseInfoOutput('Live\tNA\tTrue\tis_live');

    assert.equal(parsed.title, 'Live');
    assert.equal(parsed.durationMs, null);
    assert.equal(parsed.isLive, true);
});

test('parseInfoOutput на пустом выводе и мусоре возвращает null без исключения', () => {
    assert.equal(YtDlpClient.parseInfoOutput(''), null);
    assert.equal(YtDlpClient.parseInfoOutput(null), null);
    assert.equal(YtDlpClient.parseInfoOutput('garbage without tabs'), null);
});

test('parseInfoOutput берёт первую непустую строку и понимает NA в названии', () => {
    const parsed = YtDlpClient.parseInfoOutput('\n\t120\tFalse\tnot_live\nsecond\t300\tFalse\tnot_live');

    assert.equal(parsed.title, null);
    assert.equal(parsed.durationMs, 120000);
    assert.equal(parsed.isLive, false);
});

test('parseInfoOutput сохраняет табуляцию внутри названия трека', () => {
    assert.deepEqual(
        YtDlpClient.parseInfoOutput('AC\tDC — Back in Black\t255\tFalse\tnot_live'),
        { title: 'AC\tDC — Back in Black', durationMs: 255000, isLive: false }
    );
});

test('classifyDownloadFailure классифицирует только фильтр длительности', () => {
    assert.equal(
        YtDlpClient.classifyDownloadFailure(1, 'ERROR: Video does not pass filter duration < 60'),
        'TOO_LONG'
    );
    assert.equal(YtDlpClient.classifyDownloadFailure(0, ''), null);
    assert.equal(YtDlpClient.classifyDownloadFailure(1, 'ERROR: unavailable'), null);
});

test('extractFailureDetail: только WARNING о версии возвращается как есть', () => {
    const warning = 'WARNING: Your yt-dlp version 2026.05.01 is older than 90 days!';

    assert.equal(YtDlpClient.extractFailureDetail(`${warning}\n`, ''), warning);
});

test('extractFailureDetail: ERROR-строка stderr важнее WARNING', () => {
    const stderr = [
        'ERROR: [youtube] Video unavailable',
        'WARNING: Your yt-dlp version 2026.05.01 is older than 90 days!'
    ].join('\n');

    assert.equal(
        YtDlpClient.extractFailureDetail(stderr, ''),
        'ERROR: [youtube] Video unavailable'
    );
});

test('extractFailureDetail: пустой stderr — берётся последняя строка stdout', () => {
    assert.equal(
        YtDlpClient.extractFailureDetail('', 'ERROR: something\n'),
        'ERROR: something'
    );
});

test('extractFailureDetail: пустые потоки дают Unknown', () => {
    assert.equal(YtDlpClient.extractFailureDetail('', ''), 'Unknown');
    assert.equal(YtDlpClient.extractFailureDetail(null, undefined), 'Unknown');
});

test('extractFailureDetail обрезает строку до 500 символов', () => {
    const longLine = `ERROR: ${'x'.repeat(600)}`;
    const detail = YtDlpClient.extractFailureDetail(longLine, '');

    assert.equal(detail.length, 500);
    assert.ok(detail.startsWith('ERROR: '));
});
