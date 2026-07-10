module.exports = {
    name: 'resume',
    adminOnly: false,
    async execute(message) {
        const client = message.client;
        const session = client.getSession(message.guild.id);
        
        if (!session || session.player.state.status !== 'paused') {
            await message.reply(client.config.messages.resumeAlready);
            return;
        }

        session.resume();
        await message.reply(client.config.messages.resumeSuccess);
    }
};
