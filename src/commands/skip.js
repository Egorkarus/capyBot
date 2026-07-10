module.exports = {
    name: 'skip',
    adminOnly: false,
    async execute(message) {
        const client = message.client;
        const session = client.getSession(message.guild.id);
        
        if (!session) {
            return; // Ничего не играет, можно просто проигнорировать
        }

        await session.skip();
        await message.reply(client.config.messages.skipSuccess);
    }
};
