const fs = require('fs');
const path = require('path');
const { logInfo, logError } = require('./logger');

function reloadModules(client) {
    try {
        logInfo('Starting Zero-Downtime Hot Reload...');

        // Clear require cache for commands
        const commandsPath = path.join(__dirname, '..', 'commands');
        if (fs.existsSync(commandsPath)) {
            const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
            for (const file of commandFiles) {
                const filePath = path.join(commandsPath, file);
                delete require.cache[require.resolve(filePath)];
            }
        }

        // Clear require cache for events
        const eventsPath = path.join(__dirname, '..', 'events');
        if (fs.existsSync(eventsPath)) {
            const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));
            for (const file of eventFiles) {
                const filePath = path.join(eventsPath, file);
                delete require.cache[require.resolve(filePath)];
            }
        }

        // Clear require cache for structures
        const structuresPath = path.join(__dirname, '..', 'structures');
        if (fs.existsSync(structuresPath)) {
            const structureFiles = fs.readdirSync(structuresPath).filter(file => file.endsWith('.js'));
            for (const file of structureFiles) {
                const filePath = path.join(structuresPath, file);
                delete require.cache[require.resolve(filePath)];
            }
        }

        // Reload commands and events on client
        client.loadCommands();
        client.loadEvents();

        // Update prototype of active sessions so existing sessions inherit new class methods instantly
        if (client.sessions && client.sessions.size > 0) {
            const guildSessionPath = path.join(__dirname, '..', 'structures', 'GuildSession.js');
            delete require.cache[require.resolve(guildSessionPath)];
            const FreshGuildSession = require(guildSessionPath);
            for (const session of client.sessions.values()) {
                Object.setPrototypeOf(session, FreshGuildSession.prototype);
            }
            logInfo(`Updated prototype for ${client.sessions.size} active sessions.`);
        }

        logInfo('Zero-Downtime Hot Reload completed successfully!');
        return true;
    } catch (error) {
        logError('Error during Hot Reload', error);
        return false;
    }
}

module.exports = {
    reloadModules
};
