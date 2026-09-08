const { logInfo, logError } = require('../utils/logger');

module.exports = {
    name: 'reload',
    adminOnly: true,
    async execute(message) {
        const client = message.client;
        
        try {
            const commandCountBefore = client.commands.size;
            const eventCountBefore = client.eventHandlers.size;
            
            client.loadCommands();
            client.loadEvents();
            
            const commandCountAfter = client.commands.size;
            const eventCountAfter = client.eventHandlers.size;
            
            logInfo(`Hot reload completed: commands ${commandCountBefore}->${commandCountAfter}, events ${eventCountBefore}->${eventCountAfter}`);
            
            await message.reply(`🍊 Горячая перезагрузка завершена!\n📦 Команды: **${commandCountAfter}**\n⚡ События: **${eventCountAfter}**\n\nВсе системы в норме, продолжаем чиллить. 👑`);
        } catch (error) {
            logError('Hot reload failed', error);
            await message.reply('❌ Ошибка при горячей перезагрузке. Проверьте логи. 🍊');
        }
    }
};
