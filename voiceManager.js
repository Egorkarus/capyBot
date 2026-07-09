const { joinVoiceChannel, entersState, VoiceConnectionStatus, getVoiceConnection } = require('@discordjs/voice');
const { AuditLogEvent } = require('discord.js');
const { logInfo, logError } = require('./logger');

const guildStates = new Map();

function getVoiceState(guildId) {
    return guildStates.get(guildId);
}

function setVoiceState(guildId, voiceChannelId, textChannelId) {
    guildStates.set(guildId, {
        voiceChannelId,
        textChannelId,
        reconnectAttempts: 0,
        isReconnecting: false
    });
}

function removeVoiceState(guildId) {
    guildStates.delete(guildId);
}

async function findKicker(guild, botId) {
    try {
        const auditLogs = await guild.fetchAuditLogs({
            limit: 5,
            type: AuditLogEvent.MemberDisconnect
        });
        const currentTimestamp = Date.now();
        const entry = auditLogs.entries.find(e => e.target?.id === botId && (currentTimestamp - e.createdTimestamp) < 30000);
        return entry ? entry.executor.username : null;
    } catch (error) {
        logError("Failed to fetch audit logs", error);
        return null;
    }
}

async function reconnect(client, guildId) {
    const state = guildStates.get(guildId);
    if (!state || state.isReconnecting) {
        return;
    }

    state.isReconnecting = true;
    state.reconnectAttempts = 0;

    const guild = client.guilds.cache.get(guildId);
    if (guild) {
        const kicker = await findKicker(guild, client.user.id);
        const textChannel = guild.channels.cache.get(state.textChannelId);
        if (textChannel) {
            const warningMessage = kicker
                ? `Эй! Наглый ${kicker} посмел выгнать великую капибару! Возвращаюсь... 🍊⚔️`
                : "Эй! Какая-то дерзкая личность вышвырнула меня! Возвращаюсь... 🍊⚔️";
            await textChannel.send(warningMessage);
        }
    }

    const existingConnection = getVoiceConnection(guildId);
    if (existingConnection) {
        try {
            existingConnection.destroy();
        } catch (destroyError) {
            logError("Failed to destroy connection before reconnecting", destroyError);
        }
    }

    const maxAttempts = 5;
    const baseDelay = 2000;

    while (state.reconnectAttempts < maxAttempts) {
        state.reconnectAttempts++;
        const delay = baseDelay * Math.pow(2, state.reconnectAttempts - 1);
        await new Promise(resolve => setTimeout(resolve, delay));

        const activeGuild = client.guilds.cache.get(guildId);
        if (!activeGuild) {
            guildStates.delete(guildId);
            return;
        }

        const channel = activeGuild.channels.cache.get(state.voiceChannelId);
        if (!channel) {
            const textChannel = activeGuild.channels.cache.get(state.textChannelId);
            if (textChannel) {
                await textChannel.send("❌ Канала-то больше нет! Куда мне заходить, в пустоту? 🏝️");
            }
            guildStates.delete(guildId);
            return;
        }

        let connection;
        try {
            connection = joinVoiceChannel({
                channelId: state.voiceChannelId,
                guildId: guildId,
                adapterCreator: activeGuild.voiceAdapterCreator,
                selfDeaf: true
            });

            await entersState(connection, VoiceConnectionStatus.Ready, 10000);

            const textChannel = activeGuild.channels.cache.get(state.textChannelId);
            if (textChannel) {
                await textChannel.send("🍊 Хех, связь упала, но капибара всегда возвращается. Я снова в канале! 👑");
            }

            state.reconnectAttempts = 0;
            state.isReconnecting = false;
            return;
        } catch (error) {
            logError(`Reconnect attempt ${state.reconnectAttempts} failed`, error);
            if (connection) {
                try {
                    connection.destroy();
                } catch (connectionError) {
                    logError("Failed to destroy connection during reconnect failure", connectionError);
                }
            }
        }
    }

    const finalGuild = client.guilds.cache.get(guildId);
    if (finalGuild) {
        const textChannel = finalGuild.channels.cache.get(state.textChannelId);
        if (textChannel) {
            await textChannel.send("❌ Всё, я устал, я ухожу. Попытки кончились, позовите попозже. 🛌");
        }
    }
    guildStates.delete(guildId);
}

module.exports = {
    getVoiceState,
    setVoiceState,
    removeVoiceState,
    findKicker,
    reconnect
};
