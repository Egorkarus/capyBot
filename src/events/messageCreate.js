const { PermissionFlagsBits } = require('discord.js');
const { logError } = require('../utils/logger');

module.exports = {
    name: 'messageCreate',
    once: false,
    async execute(client, message) {
        if (message.author.bot || !message.content.startsWith(client.config.bot.prefix)) {
            return;
        }

        const args = message.content.slice(client.config.bot.prefix.length).trim().split(/ +/);
        const commandName = args.shift().toLowerCase();

        const command = client.commands.get(commandName);
        if (!command) return;

        if (command.adminOnly && client.config.bot.adminPermissions && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            await message.reply(client.config.messages.noPermission);
            return;
        }

        try {
            await command.execute(message, args);
        } catch (error) {
            logError(`Error executing command ${commandName}`, error);
            await message.reply(client.config.messages.errorExecution);
        }
    }
};
