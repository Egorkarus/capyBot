const { logError } = require('../utils/logger');

module.exports = {
    name: 'voiceStateUpdate',
    once: false,
    async execute(client, oldState, newState) {
        if (newState.id !== client.user.id) return;

        // Реагируем только на выход бота из канала.
        if (!oldState.channelId || newState.channelId) return;

        const session = client.getSession(oldState.guild.id);
        if (!session || session.destroyed) return;

        try {
            await session.reconnect(client, oldState.guild.id);
        } catch (error) {
            logError('Failed to reconnect after voice disconnect', error);
        }
    }
};
