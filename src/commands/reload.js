const { reloadModules } = require('../utils/reloader');

module.exports = {
    name: 'reload',
    adminOnly: true,
    async execute(message) {
        const client = message.client;
        const success = reloadModules(client);
        
        if (success) {
            await message.reply('🔄 Логика команд и событий успешно перезагружена на лету!');
        } else {
            await message.reply('❌ Ошибка при перезагрузке модулей. Проверьте консоль бота.');
        }
    }
};
