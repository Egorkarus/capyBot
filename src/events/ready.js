const { logInfo } = require('../utils/logger');

module.exports = {
    name: 'ready',
    once: true,
    execute(client) {
        logInfo(`Logged in as ${client.user.tag}`);
    }
};
