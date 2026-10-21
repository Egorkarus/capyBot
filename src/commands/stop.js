module.exports = {
    name: 'stop',
    adminOnly: true,
    async execute(message) {
        const client = message.client;
        const session = client.getSession(message.guild.id);
        
        if (!session) {
            return;
        }

        await session.stop();
        // За время await сессию могли заменить (!join/!play) — чужую не удаляем.
        if (client.getSession(message.guild.id) === session) {
            client.deleteSession(message.guild.id);
        }
        await message.reply(client.config.messages.stopSuccess);
    }
};
