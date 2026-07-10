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
        await message.reply(client.config.messages.stopSuccess);
    }
};
