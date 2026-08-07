require('dotenv').config();
const CapyClient = require('./CapyClient');
const { logError } = require('./utils/logger');

if (!process.env.DISCORD_TOKEN) {
    logError("DISCORD_TOKEN is not defined in environment variables");
    process.exit(1);
}

const client = new CapyClient();

client.init().then(() => {
    client.login(process.env.DISCORD_TOKEN);
}).catch(err => {
    logError("Failed to initialize bot client", err);
});
