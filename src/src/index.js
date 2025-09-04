const express = require('express');
const TelegramBot = require('./bot/telegramBot');
const TradingEngine = require('./trading/tradingEngine');
const logger = require('./utils/logger');

class VolumeBoosterBot {
  constructor() {
    this.app = express();
    this.telegramBot = new TelegramBot();
    this.tradingEngine = new TradingEngine();
    this.isActive = false;
    this.currentStrategy = null;
    
    // Setup Express middleware
    this.setupExpress();
  }

  setupExpress() {
    // Health check endpoint for Render monitoring
    this.app.get('/health', (req, res) => {
      res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'solana-volume-bot',
        active: this.isActive,
        uptime: process.uptime()
      });
    });
    
    // Additional endpoints for monitoring
    this.app.get('/stats', async (req, res) => {
      try {
        const stats = await this.tradingEngine.getStatistics();
        res.json({
          ...stats,
          status: 'success'
        });
      } catch (error) {
        logger.error('Error getting stats via HTTP:', error);
        res.status(500).json({ 
          error: error.message,
          status: 'error'
        });
      }
    });
    
    // Basic request logging
    this.app.use((req, res, next) => {
      logger.info(`${new Date().toISOString()} - ${req.method} ${req.path}`);
      next();
    });
  }

  async initialize() {
    try {
      logger.info('Initializing Solana Volume Booster Bot...');
      
      // Initialize trading engine
      await this.tradingEngine.initialize();
      
      // Setup Telegram bot commands
      this.setupCommands();
      
      // Start Express server for health checks
      const PORT = process.env.PORT || 3000;
      this.server = this.app.listen(PORT, '0.0.0.0', () => {
        logger.info(`Health check server running on port ${PORT}`);
        logger.info(`Health endpoint available at: http://0.0.0.0:${PORT}/health`);
      });
      
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
    
    this.telegramBot.onCommand('health', (msg) => {
      this.handleHealthCommand(msg);
    });
  }

  async handleStartCommand(msg) {
    const chatId = msg.chat.id;
    const welcomeMessage = `🚀 Solana Volume Booster Bot Activated!\n\n` +
      `Available Commands:\n` +
      `/boost - Start volume boosting\n` +
      `/stop - Stop all activities\n` +
      `/stats - Show trading statistics\n` +
      `/balance - Check wallet balance\n` +
      `/health - Check bot health status\n\n` +
      `Ensure your wallet is funded with SOL for trading fees.`;
    
    this.telegramBot.sendMessage(chatId, welcomeMessage);
  }

  async handleBoostCommand(msg) {
    const chatId = msg.chat.id;
    
    // Check if already active
    if (this.isActive) {
      this.telegramBot.sendMessage(chatId, 'A strategy is already running. Use /stop first.');
      return;
    }
    
    try {
      this.telegramBot.sendMessage(chatId, 'Starting volume boost strategy...');
      
      // Parse parameters from message
      const params = this.parseBoostParameters(msg.text);
      
      // Validate parameters
      if (!params.tokenAddress) {
        this.telegramBot.sendMessage(chatId, 'Error: No token address provided. Use format: /boost -t TOKEN_ADDRESS -a 0.1 -d 60 -i 30');
        return;
      }
      
      // Start trading strategy
      this.isActive = true;
      this.currentStrategy = await this.tradingEngine.startVolumeBoostStrategy(params);
      
      this.telegramBot.sendMessage(chatId, 
        `✅ Volume boost started with parameters:\n` +
        `• Token: ${params.tokenAddress}\n` +
        `• SOL Amount: ${params.solAmount}\n` +
        `• Duration: ${params.durationMinutes} minutes\n` +
        `• Trade Interval: ${params.tradeIntervalSecs} seconds\n\n` +
        `Monitor progress with /stats`
      );
      
    } catch (error) {
      this.isActive = false;
      this.currentStrategy = null;
      this.telegramBot.sendMessage(chatId, `❌ Error starting boost: ${error.message}`);
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
        this.telegramBot.sendMessage(chatId, '🛑 Trading strategy stopped successfully.');
      } else {
        this.telegramBot.sendMessage(chatId, 'ℹ️ No active strategy to stop.');
      }
    } catch (error) {
      this.telegramBot.sendMessage(chatId, `❌ Error stopping strategy: ${error.message}`);
      logger.error('Stop command error:', error);
    }
  }

  async handleStatsCommand(msg) {
    const chatId = msg.chat.id;
    
    try {
      const stats = await this.tradingEngine.getStatistics();
      const message = `📊 Trading Statistics:\n\n` +
        `• Total Trades: ${stats.totalTrades}\n` +
        `• Total Volume: ${stats.totalVolume.toFixed(4)} SOL\n` +
        `• Fees Spent: ${stats.feesSpent.toFixed(4)} SOL\n` +
        `• Active: ${this.isActive ? 'Yes' : 'No'}\n` +
        `• Uptime: ${stats.uptime}\n` +
        `• Start Time: ${stats.startTime || 'N/A'}`;
      
      this.telegramBot.sendMessage(chatId, message);
    } catch (error) {
      this.telegramBot.sendMessage(chatId, `❌ Error retrieving stats: ${error.message}`);
      logger.error('Stats command error:', error);
    }
  }

  async handleBalanceCommand(msg) {
    const chatId = msg.chat.id;
    
    try {
      const balance = await this.tradingEngine.getWalletBalance();
      this.telegramBot.sendMessage(chatId, `💰 Wallet Balance: ${balance.toFixed(4)} SOL`);
    } catch (error) {
      this.telegramBot.sendMessage(chatId, `❌ Error checking balance: ${error.message}`);
      logger.error('Balance command error:', error);
    }
  }
  
  async handleHealthCommand(msg) {
    const chatId = msg.chat.id;
    
    try {
      const balance = await this.tradingEngine.getWalletBalance();
      const stats = await this.tradingEngine.getStatistics();
      
      const message = `❤️ Health Status:\n\n` +
        `• Bot: Operational\n` +
        `• Wallet: ${balance.toFixed(4)} SOL\n` +
        `• Trading Engine: Connected\n` +
        `• Active Strategy: ${this.isActive ? 'Running' : 'Inactive'}\n` +
        `• Total Trades: ${stats.totalTrades}\n` +
        `• Uptime: ${stats.uptime}`;
      
      this.telegramBot.sendMessage(chatId, message);
    } catch (error) {
      this.telegramBot.sendMessage(chatId, `❌ Health check failed: ${error.message}`);
      logger.error('Health command error:', error);
    }
  }

  parseBoostParameters(text) {
    // Default parameters
    const params = {
      tokenAddress: process.env.DEFAULT_TOKEN_ADDRESS,
      solAmount: parseFloat(process.env.DEFAULT_SOL_AMOUNT) || 0.1,
      durationMinutes: parseInt(process.env.DEFAULT_DURATION) || 60,
      tradeIntervalSecs: parseInt(process.env.DEFAULT_INTERVAL) || 30,
      slippageBps: parseInt(process.env.SLIPPAGE_BPS) || 100 // 1% slippage
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
      } else if (args[i] === '-s' && args[i + 1]) {
        params.slippageBps = parseInt(args[i + 1]);
        i++;
      }
    }

    return params;
  }

  async shutdown() {
    logger.info('Shutting down bot gracefully...');
    
    // Stop any active trading strategy
    if (this.isActive) {
      await this.tradingEngine.stopStrategy().catch(error => {
        logger.error('Error stopping strategy during shutdown:', error);
      });
    }
    
    // Close the Express server
    if (this.server) {
      this.server.close(() => {
        logger.info('HTTP server closed.');
      });
    }
    
    // Additional cleanup if needed
    logger.info('Bot shutdown completed.');
  }
}

// Initialize and start the bot
const bot = new VolumeBoosterBot();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal');
  await bot.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal');
  await bot.shutdown();
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  bot.shutdown().finally(() => {
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  bot.shutdown().finally(() => {
    process.exit(1);
  });
});

// Start the application
bot.initialize().catch(error => {
  logger.error('Failed to start bot:', error);
  process.exit(1);
});

module.exports = VolumeBoosterBot;
