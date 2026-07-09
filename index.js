require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');

const { logInfo, logWarn, logError } = require('./logger');
const { getVoiceState, removeVoiceState, findKicker, reconnect } = require('./voiceManager');

if (!process.env.DISCORD_TOKEN) {
    logError("DISCORD_TOKEN is not defined in environment variables");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

client.commands = new Map();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if (command.name && typeof command.execute === 'function') {
        client.commands.set(command.name, command);
    }
}

client.once('clientReady', () => {
    logInfo(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!')) {
        return;
    }

    const args = message.content.slice(1).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    const command = client.commands.get(commandName);
    if (!command) {
        return;
    }

    if (command.adminOnly && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await message.reply("Ты кто такой? Только вожаки стаи могут мной командовать. 🍊");
        return;
    }

    try {
        await command.execute(message, args);
    } catch (error) {
        logError(`Error executing command ${commandName}`, error);
        await message.reply("Произошла ошибка при выполнении этой команды. 🍊");
    }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    if (newState.id !== client.user.id) {
        return;
    }

    if (oldState.channelId && !newState.channelId) {
        await reconnect(client, oldState.guild.id);
    }
});

client.login(process.env.DISCORD_TOKEN);
