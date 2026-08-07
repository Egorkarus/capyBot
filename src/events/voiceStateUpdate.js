module.exports = {
    name: 'voiceStateUpdate',
    once: false,
    async execute(client, oldState, newState) {
        if (newState.id !== client.user.id) return;
        if (oldState.channelId && !newState.channelId) {
            const session = client.getSession(oldState.guild.id);
            if (session) {
                await session.reconnect(client, oldState.guild.id);
            }
        }
    }
};
