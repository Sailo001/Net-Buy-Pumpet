const TelegramApi = require('node-telegram-bot-api');
const logger = require('../utils/logger');

class TelegramBot {
  constructor() {
    this.bot = null;
    this.commandHandlers = new Map();
  }

  initialize() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const authorizedUserId = process.env.TELEGRAM_USER_ID;

    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is required in environment variables');
    }

    this.bot = new TelegramApi(token, { polling: true });

    // Middleware to check user authorization
    this.bot.on('message', (msg) => {
      if (msg.from.id.toString() !== authorizedUserId) {
        this.sendMessage(msg.chat.id, '⛔ Unauthorized access. This incident will be reported.');
        logger.warn(`Unauthorized access attempt from user ID: ${msg.from.id}`);
        return false;
      }
      return true;
    });

    // Handle commands
    this.bot.onText(/\/(.+)/, (msg, match) => {
      const command = match[1].split(' ')[0];
      const handler = this.commandHandlers.get(command);
      
      if (handler) {
        handler(msg);
      } else {
        this.sendMessage(msg.chat.id, `Unknown command: /${command}`);
      }
    });

    logger.info('Telegram bot initialized');
  }

  onCommand(command, handler) {
    this.commandHandlers.set(command, handler);
  }

  sendMessage(chatId, message) {
    this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' })
      .catch(error => {
        logger.error('Failed to send Telegram message:', error);
      });
  }

  sendAlert(message) {
    const chatId = process.env.TELEGRAM_USER_ID;
    this.sendMessage(chatId, `🚨 ALERT: ${message}`);
  }
}

module.exports = TelegramBot;
