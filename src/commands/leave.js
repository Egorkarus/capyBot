const { logInfo } = require('../logger');

module.exports = {
    name: 'leave',
    adminOnly: true,
    async execute(message) {
        const client = message.client;
        const session = client.getSession(message.guild.id);
        
        if (!session) {
            await message.reply(client.config.messages.notWithYou);
            return;
        }

        session.destroy();
        client.deleteSession(message.guild.id);
        
        logInfo(`Left voice channel in guild ${message.guild.id}`);
        await message.reply(client.config.messages.leaveSuccess);
    }
};
