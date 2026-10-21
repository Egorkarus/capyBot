const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const { logError, logInfo, logWarn } = require('../utils/logger');

// Соединение, созданное до входа в канал, нужно уничтожать на всех ветках ошибки:
// иначе бот остаётся в голосовом канале без живой сессии.
const destroyVoiceConnection = connection => {
    if (!connection) return;
    try {
        connection.destroy();
    } catch (error) {
        logWarn('Failed to destroy voice connection on join', error);
    }
};

module.exports = {
    name: 'join',
    adminOnly: true,
    async execute(message) {
        const client = message.client;
        const voiceChannel = message.member?.voice.channel;
        
        if (!voiceChannel) {
            await message.reply(client.config.messages.notInVoice);
            return;
        }

        let session = client.getSession(message.guild.id);
        if (session && session.voiceChannelId === voiceChannel.id) {
            await message.reply(client.config.messages.alreadyInVoice);
            return;
        }

        if (session) {
            try {
                await session.destroy();
            } catch (error) {
                logError('Failed to destroy previous session before join', error);
            }
        }

        session = client.createSession(message.guild.id, voiceChannel.id, message.channel.id);

        let newConnection = null;
        try {
            newConnection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: true
            });

            await entersState(newConnection, VoiceConnectionStatus.Ready, client.config.timeouts.joinReady);

            // Пока ждали Ready, пользователь мог выполнить !leave/!stop, а другой —
            // создать новую сессию. Чужую сессию не трогаем, соединение не подписываем.
            if (session.destroyed || client.getSession(message.guild.id) !== session) {
                destroyVoiceConnection(newConnection);
                // Сессия уничтожена, но всё ещё владеет записью в мапе: иначе
                // «зомби» без соединения навсегда занимает гильдию.
                if (client.getSession(message.guild.id) === session) {
                    client.deleteSession(message.guild.id);
                }
                await message.reply(client.config.messages.joinFail);
                return;
            }

            if (session.setConnection(newConnection, message.channel) === false) {
                // setConnection отказал уничтоженной сессии и сам закрыл соединение.
                await message.reply(client.config.messages.joinFail);
                return;
            }
            
            logInfo(`Joined voice channel ${voiceChannel.id}`);
            await message.reply(client.config.messages.joinSuccess);
        } catch (error) {
            logError("Failed to join voice channel", error);
            destroyVoiceConnection(newConnection);
            if (client.getSession(message.guild.id) === session) {
                client.deleteSession(message.guild.id);
            }
            await message.reply(client.config.messages.joinFail);
        }
    }
};
