module.exports = {
    name: 'help',
    adminOnly: false,
    async execute(message) {
        const client = message.client;
        const commands = client.commands;
        
        if (!commands || commands.size === 0) {
            await message.reply(client.config.messages.noCommands);
            return;
        }

        const helpText = Array.from(commands.values())
            .map(cmd => `**${client.config.bot.prefix}${cmd.name}** — ${client.config.commandDescriptions[cmd.name] || 'Описание отсутствует.'}`)
            .join('\n');

        await message.reply(`${client.config.messages.helpHeader}\n\n${helpText}`);
    }
};
