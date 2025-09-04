const TelegramBot = require('./bot/telegramBot');
const TradingEngine = require('./trading/tradingEngine');
const logger = require('./utils/logger');

class VolumeBoosterBot {
  constructor() {
    this.telegramBot = new TelegramBot();
    this.tradingEngine = new TradingEngine();
    this.isActive = false;
    this.currentStrategy = null;
  }

  async initialize() {
    try {
      logger.info('Initializing Solana Volume Booster Bot...');
      
      // Initialize trading engine
      await this.tradingEngine.initialize();
      
      // Setup Telegram bot commands
      this.setupCommands();
      
      logger.info('Bot initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize bot:', error);
      process.exit(1);
    }
  }

  setupCommands() {
    this.telegramBot.onCommand('start', (msg) => {
      this.handleStartCommand(msg);
    });

    this.telegramBot.onCommand('boost', (msg) => {
      this.handleBoostCommand(msg);
    });

    this.telegramBot.onCommand('stop', (msg) => {
      this.handleStopCommand(msg);
    });

    this.telegramBot.onCommand('stats', (msg) => {
      this.handleStatsCommand(msg);
    });

    this.telegramBot.onCommand('balance', (msg) => {
      this.handleBalanceCommand(msg);
    });
  }

  async handleStartCommand(msg) {
    const chatId = msg.chat.id;
    const welcomeMessage = `🚀 Solana Volume Booster Bot Activated!\n\n` +
      `Available Commands:\n` +
      `/boost - Start volume boosting\n` +
      `/stop - Stop all activities\n` +
      `/stats - Show trading statistics\n` +
      `/balance - Check wallet balance\n\n` +
      `Ensure your wallet is funded with SOL for trading fees.`;
    
    this.telegramBot.sendMessage(chatId, welcomeMessage);
  }

  async handleBoostCommand(msg) {
    const chatId = msg.chat.id;
    
    try {
      this.telegramBot.sendMessage(chatId, 'Starting volume boost strategy...');
      
      // Parse parameters from message
      const params = this.parseBoostParameters(msg.text);
      
      // Start trading strategy
      this.isActive = true;
      this.currentStrategy = await this.tradingEngine.startVolumeBoostStrategy(params);
      
      this.telegramBot.sendMessage(chatId, 
        `Volume boost started with parameters:\n` +
        `Token: ${params.tokenAddress}\n` +
        `SOL Amount: ${params.solAmount}\n` +
        `Duration: ${params.durationMinutes} minutes\n` +
        `Trade Interval: ${params.tradeIntervalSecs} seconds`
      );
      
    } catch (error) {
      this.telegramBot.sendMessage(chatId, `Error starting boost: ${error.message}`);
      logger.error('Boost command error:', error);
    }
  }

  async handleStopCommand(msg) {
    const chatId = msg.chat.id;
    
    try {
      if (this.isActive && this.currentStrategy) {
        await this.tradingEngine.stopStrategy();
        this.isActive = false;
        this.currentStrategy = null;
        this.telegramBot.sendMessage(chatId, 'Trading strategy stopped successfully.');
      } else {
        this.telegramBot.sendMessage(chatId, 'No active strategy to stop.');
      }
    } catch (error) {
      this.telegramBot.sendMessage(chatId, `Error stopping strategy: ${error.message}`);
      logger.error('Stop command error:', error);
    }
  }

  async handleStatsCommand(msg) {
    const chatId = msg.chat.id;
    
    try {
      const stats = await this.tradingEngine.getStatistics();
      const message = `📊 Trading Statistics:\n\n` +
        `Total Trades: ${stats.totalTrades}\n` +
        `Total Volume: ${stats.totalVolume} SOL\n` +
        `Current SOL Balance: ${stats.solBalance}\n` +
        `Estimated Fees Spent: ${stats.feesSpent} SOL\n` +
        `Active Since: ${stats.startTime || 'N/A'}`;
      
      this.telegramBot.sendMessage(chatId, message);
    } catch (error) {
      this.telegramBot.sendMessage(chatId, `Error retrieving stats: ${error.message}`);
      logger.error('Stats command error:', error);
    }
  }

  async handleBalanceCommand(msg) {
    const chatId = msg.chat.id;
    
    try {
      const balance = await this.tradingEngine.getWalletBalance();
      this.telegramBot.sendMessage(chatId, `💰 Wallet Balance: ${balance} SOL`);
    } catch (error) {
      this.telegramBot.sendMessage(chatId, `Error checking balance: ${error.message}`);
      logger.error('Balance command error:', error);
    }
  }

  parseBoostParameters(text) {
    // Default parameters
    const params = {
      tokenAddress: process.env.DEFAULT_TOKEN_ADDRESS,
      solAmount: parseFloat(process.env.DEFAULT_SOL_AMOUNT) || 0.1,
      durationMinutes: parseInt(process.env.DEFAULT_DURATION) || 60,
      tradeIntervalSecs: parseInt(process.env.DEFAULT_INTERVAL) || 30,
      slippageBps: 100 // 1% slippage
    };

    // Parse custom parameters from message text
    const args = text.split(' ').slice(1);
    
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-t' && args[i + 1]) {
        params.tokenAddress = args[i + 1];
        i++;
      } else if (args[i] === '-a' && args[i + 1]) {
        params.solAmount = parseFloat(args[i + 1]);
        i++;
      } else if (args[i] === '-d' && args[i + 1]) {
        params.durationMinutes = parseInt(args[i + 1]);
        i++;
      } else if (args[i] === '-i' && args[i + 1]) {
        params.tradeIntervalSecs = parseInt(args[i + 1]);
        i++;
      }
    }

    return params;
  }
}

// Initialize and start the bot
const bot = new VolumeBoosterBot();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down bot...');
  if (bot.isActive) {
    await bot.tradingEngine.stopStrategy();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...');
  if (bot.isActive) {
    await bot.tradingEngine.stopStrategy();
  }
  process.exit(0);
});

// Start the application
bot.initialize().catch(error => {
  logger.error('Failed to start bot:', error);
  process.exit(1);
});

module.exports = VolumeBoosterBot;
