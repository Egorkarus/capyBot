const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StreamType } = require('@discordjs/voice');

const { isOpusContainer, resolvePlaybackOptions } = require('../src/utils/AudioInputType');

test('isOpusContainer распознаёт opus/ogg в любом регистре', () => {
    assert.equal(isOpusContainer('temp/a.opus'), true);
    assert.equal(isOpusContainer('temp/a.ogg'), true);
    assert.equal(isOpusContainer('temp/A.OPUS'), true);
});

test('isOpusContainer отвергает другие контейнеры', () => {
    assert.equal(isOpusContainer('temp/a.mp3'), false);
    assert.equal(isOpusContainer('temp/a.m4a'), false);
    assert.equal(isOpusContainer('temp/a.webm'), false);
});

test('isOpusContainer безопасен для пустого пути', () => {
    assert.equal(isOpusContainer(null), false);
    assert.equal(isOpusContainer(''), false);
});

test('resolvePlaybackOptions отдаёт OggOpus для opus/ogg', () => {
    assert.equal(resolvePlaybackOptions('temp/a.opus').inputType, StreamType.OggOpus);
});

test('resolvePlaybackOptions не задаёт inputType для остальных форматов', () => {
    assert.deepEqual(resolvePlaybackOptions('temp/a.mp3'), {});
});
