require('dotenv').config();
const { PermissionFlagsBits } = require('discord.js');
const CapyClient = require('./CapyClient');
const { logError } = require('./logger');

if (!process.env.DISCORD_TOKEN) {
    logError("DISCORD_TOKEN is not defined in environment variables");
    process.exit(1);
}

const client = new CapyClient();

client.on('messageCreate', async (message) => {
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
});

client.init().then(() => {
    client.login(process.env.DISCORD_TOKEN);
});
