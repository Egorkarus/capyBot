module.exports = {
    name: 'queue',
    adminOnly: false,
    async execute(message) {
        const client = message.client;
        const session = client.getSession(message.guild.id);
        
        if (!session || session.tracks.length === 0) {
            await message.reply(client.config.messages.queueEmpty);
            return;
        }

        const trackList = session.tracks
            .slice(0, 10)
            .map((track, index) => `${index + 1}. **${track.title}**`)
            .join('\n');

        const remainingCount = session.tracks.length - 10;
        const extraText = remainingCount > 0 ? `\n...и еще ${remainingCount} треков.` : '';

        await message.reply(`${client.config.messages.queueHeader}\n${trackList}${extraText}`);
    }
};
