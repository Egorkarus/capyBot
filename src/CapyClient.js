const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { logInfo, logError } = require('./utils/logger');
const GuildSession = require('./structures/GuildSession');
const { reloadModules } = require('./utils/reloader');

class CapyClient extends Client {
    constructor() {
        super({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildVoiceStates
            ]
        });

        this.commands = new Map();
        this.sessions = new Map();
        this.config = config;
        this.eventHandlers = new Map();

        // Bind SIGUSR2 process signal for HMR
        process.on('SIGUSR2', () => {
            logInfo('Received SIGUSR2 signal. Triggering Hot Reload...');
            reloadModules(this);
        });
    }

    async init() {
        this.loadCommands();
        this.loadEvents();
        await this.cleanTempDirectory();
    }

    loadCommands() {
        this.commands.clear();
        const commandsPath = path.join(__dirname, 'commands');
        if (!fs.existsSync(commandsPath)) return;

        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            delete require.cache[require.resolve(filePath)];
            const command = require(filePath);
            if (command.name && typeof command.execute === 'function') {
                this.commands.set(command.name, command);
            }
        }
        logInfo(`Loaded ${this.commands.size} commands.`);
    }

    loadEvents() {
        // Remove previously registered dynamic events
        for (const [eventName, handler] of this.eventHandlers.entries()) {
            this.removeListener(eventName, handler);
        }
        this.eventHandlers.clear();

        const eventsPath = path.join(__dirname, 'events');
        if (!fs.existsSync(eventsPath)) return;

        const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));
        for (const file of eventFiles) {
            const filePath = path.join(eventsPath, file);
            delete require.cache[require.resolve(filePath)];
            const event = require(filePath);

            if (event.name && typeof event.execute === 'function') {
                const handler = (...args) => event.execute(this, ...args);
                this.eventHandlers.set(event.name, handler);

                if (event.once) {
                    this.once(event.name, handler);
                } else {
                    this.on(event.name, handler);
                }
            }
        }
        logInfo(`Loaded ${this.eventHandlers.size} event listeners.`);
    }

    getSession(guildId) {
        return this.sessions.get(guildId);
    }

    createSession(guildId, voiceChannelId, textChannelId) {
        const session = new GuildSession(guildId, voiceChannelId, textChannelId);
        this.sessions.set(guildId, session);
        return session;
    }

    deleteSession(guildId) {
        this.sessions.delete(guildId);
    }

    async cleanTempDirectory() {
        const tempPath = path.join(__dirname, '..', 'temp');
        try {
            const fsPromises = require('fs/promises');
            await fsPromises.rm(tempPath, { recursive: true, force: true });
            await fsPromises.mkdir(tempPath, { recursive: true });
        } catch (error) {
            logError("Failed to clean up temp directory on start", error);
        }
    }
}

module.exports = CapyClient;
