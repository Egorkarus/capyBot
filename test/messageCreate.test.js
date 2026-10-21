const { test } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const messageCreate = require('../src/events/messageCreate');

function createClient(commands = []) {
    return {
        commands: new Map(commands),
        config,
        user: { id: 'bot-user' }
    };
}

function createMessage(overrides = {}) {
    const replies = [];
    const message = {
        content: '!test',
        author: { bot: false },
        member: { permissions: { has: () => true } },
        reply: async text => {
            replies.push(text);
        },
        ...overrides
    };
    return { message, replies };
}

test('DM без member: adminOnly-команда отвечает noPermission и не бросает', async () => {
    const executeCalls = [];
    const client = createClient([
        ['join', { adminOnly: true, execute: async (...args) => executeCalls.push(args) }]
    ]);
    const { message, replies } = createMessage({ content: '!join', member: null });

    await assert.doesNotReject(messageCreate.execute(client, message));

    assert.deepEqual(replies, [config.messages.noPermission]);
    assert.equal(executeCalls.length, 0);
});

test('сообщение без префикса игнорируется', async () => {
    const executeCalls = [];
    const client = createClient([
        ['play', { execute: async (...args) => executeCalls.push(args) }]
    ]);
    const { message, replies } = createMessage({ content: 'play something' });

    await messageCreate.execute(client, message);

    assert.equal(replies.length, 0);
    assert.equal(executeCalls.length, 0);
});

test('сообщение от бота игнорируется', async () => {
    const executeCalls = [];
    const client = createClient([
        ['play', { execute: async (...args) => executeCalls.push(args) }]
    ]);
    const { message, replies } = createMessage({ content: '!play', author: { bot: true } });

    await messageCreate.execute(client, message);

    assert.equal(replies.length, 0);
    assert.equal(executeCalls.length, 0);
});

test('неизвестная команда не вызывает execute', async () => {
    const client = createClient();
    const { message, replies } = createMessage({ content: '!unknown' });

    await messageCreate.execute(client, message);

    assert.equal(replies.length, 0);
});

test('обычная команда получает message и массив аргументов', async () => {
    const executeCalls = [];
    const client = createClient([
        ['play', { execute: async (...args) => executeCalls.push(args) }]
    ]);
    const { message } = createMessage({ content: '!play https://example.com/a.mp3' });

    await messageCreate.execute(client, message);

    assert.equal(executeCalls.length, 1);
    assert.equal(executeCalls[0][0], message);
    assert.deepEqual(executeCalls[0][1], ['https://example.com/a.mp3']);
});

test('ошибка execute перехватывается и отвечает errorExecution', async t => {
    const originalConsoleError = console.error;
    console.error = () => {};
    t.after(() => {
        console.error = originalConsoleError;
    });

    const client = createClient([
        ['play', { execute: async () => { throw new Error('boom'); } }]
    ]);
    const { message, replies } = createMessage({ content: '!play' });

    await assert.doesNotReject(messageCreate.execute(client, message));

    assert.deepEqual(replies, [config.messages.errorExecution]);
});
