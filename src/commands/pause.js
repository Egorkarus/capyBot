module.exports = {
    name: 'pause',
    adminOnly: false,
    async execute(message) {
        const client = message.client;
        const session = client.getSession(message.guild.id);
        
        if (!session || session.player.state.status === 'idle') {
            await message.reply(client.config.messages.pauseEmpty);
            return;
        }

        session.pause();
        await message.reply(client.config.messages.pauseSuccess);
    }
};
