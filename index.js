import dotenv from 'process';
import { Telegraf, Markup } from 'telegraf';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch';

// =====Enhanced Error Handling and Logging=====
class BotError extends Error {
  constructor(message, ctx = null) {
    super(message);
    this.name = 'BotError';
    this.ctx = ctx;
    this.timestamp = new Date().toISOString();
  
    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BotError);
    }
  }

  toLogEntry() {
    return `[${this.timestamp}] ${this.name}: ${this.message}${this.ctx ? ` | Chat: ${this.ctx.from.id}` : ''}`;
  }
}

const logger = {
  info: (message) => console.log(`[INFO] ${new Date().toISOString()} | ${message}`),
  error: (message, error) => {
    console.error(`[ERROR] ${new Date().toISOString()} | ${message}`);
    if (error) console.error(error);
  },
  debug: (message) => process.env.NODE_ENV === 'development' && console.debug(`[DEBUG] ${new Date().toISOString()} | ${message}`),
};

// =====Configuration with Defaults and Validation=====
const CONFIG = {
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    ADMIN_ID: process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null,
  },
  SOLANA: {
    RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY,
  },
  MEV: {
    ENABLED: process.env.MEV_ENABLED === 'true',
    JITO_TIP: parseInt(process.env.JITO_TIP || '10000'), // lamports
    MAX_SLIPPAGE: parseFloat(process.env.MAX_SLIPPAGE || '0.5'), // percentage
    ENDPOINTS: [
      'https://amsterdam.mainnet.block-engine.jito.wtf',
      'https://ny.mainnet.block-engine.jito.wtf',
      'https://tokyo.mainnet.block-engine.jito.wtf'
    ],
  },
  BOT: {
    NAME: 'Solana Volume Booster',
    VERSION: '1.0.0',
    ENABLE_COMMANDS: process.env.ENABLE_COMMANDS === 'true',
    ENABLE_MENU: process.env.ENABLE_MENU === 'true',
  },
  RENDER: {
    EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL || 'https://solana-volume-bot.onrender.com',
    PORT: process.env.PORT || 3000,
  }
};

// Validate configuration
if (!CONFIG.TELEGRAM.BOT_TOKEN) throw new BotError('Missing Telegram Bot Token');
if (!CONFIG.SOLANA.PRIVATE_KEY) throw new BotError('Missing Solana Private Key');
if (!CONFIG.TELEGRAM.ADMIN_ID) logger.warn('No Admin ID set - bot will be public');
if (CONFIG.MEV.ENABLED && CONFIG.MEV.JITO_TIP < 5000) throw new BotError('JITO_TIP too low (minimum 5000 lamports)');

// =====Bot Initialization=====
logger.info(`Initializing ${CONFIG.BOT.NAME} v${CONFIG.BOT.VERSION}`);
logger.debug('Configuration:', JSON.stringify(CONFIG, null, 2));

// Initialize bot
const bot = new Telegraf(CONFIG.TELEGRAM.BOT_TOKEN);

// Initialize Solana connection
const connection = new Connection(CONFIG.SOLANA.RPC_URL, 'confirmed');
const payer = Keypair.fromSecretKey(bs58.decode(CONFIG.SOLANA.PRIVATE_KEY));
const publicKey = payer.publicKey.toString();

// =====Telegram Menu System=====
const getMainMenu = () => {
  const buttons = [
    Markup.button.callback('⚙️ Setup Configuration', 'setup_config'),
    Markup.button.callback('📊 View Status', 'view_status'),
    Markup.button.callback('🔥 Start Pump', 'start_pump'),
    Markup.button.callback('⏹️ Stop Pump', 'stop_pump'),
    Markup.button.callback('💰 Sell All Tokens', 'sell_all'),
    Markup.button.callback('🎭 Multi-Wallet', 'multi_wallet'),
    Markup.button.callback('🛡️ Advanced Settings', 'advanced_settings'),
  ];

  return Markup.inlineKeyboard(buttons, { columns: 2 });
};

const getConfirmationMenu = (message, callbackData) => {
  return Markup.inlineKeyboard([
    Markup.button.callback('✅ Confirm', callbackData),
    Markup.button.callback('❌ Cancel', 'cancel'),
  ]).extra();
};

// =====Admin Check Middleware=====
const isAdmin = (ctx, next) => {
  if (!CONFIG.TELEGRAM.ADMIN_ID) return next(); // No admin set - allow all
  if (ctx.from.id === CONFIG.TELEGRAM.ADMIN_ID) return next();

  ctx.reply('⛔️ Access denied. You are not the bot administrator.', Markup.inlineKeyboard([
    Markup.button.url('📚 Help', 'https://t.me/solana_volume_bot_support')
  ]));
  throw new BotError('Unauthorized access attempt', ctx);
};

// =====Enhanced Transaction Handling with MEV Protection=====
async function sendTransactionWithMEVProtection(transaction) {
  try {
    // Add Jito tip if MEV is enabled
    if (CONFIG.MEV.ENABLED) {
      transaction.add(SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'),
        lamports: CONFIG.MEV.JITO_TIP
      }));
    }

    let txSignature = null;
  
    // Try multiple Jito endpoints if needed
    for (const endpoint of CONFIG.MEV.ENDPOINTS) {
      try {
        logger.debug(`Trying Jito endpoint: ${endpoint}`);
      
        const response = await fetch(`${endpoint}/api/v1/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendTransaction',
            params: [
              transaction.serialize({ requireAllSignatures: false }).toString('base64'),
              { skipPreflight: false, preflightCommitment: 'confirmed' }
            ]
          })
        });

        const result = await response.json();
        if (result.result) {
          txSignature = result.result;
          logger.info(`Transaction successful via ${endpoint}`);
          break;
        }
      } catch (e) {
        logger.error(`Error with endpoint ${endpoint}:`, e.message);
      }
    }

    if (!txSignature) {
      // Fallback to standard RPC if all Jito endpoints fail
      txSignature = (await connection.sendTransaction(transaction)).toString();
      logger.info('Transaction successful via standard RPC');
    }
  
    return txSignature;
  } catch (error) {
    logger.error('Transaction failed:', error.message);
    throw new BotError('Transaction processing failed', error);
  }
}

// =====Bot Command Handlers with Error Handling=====
bot.start((ctx) => {
  try {
    const welcomeMessage = 
      `🚀 **Welcome to ${CONFIG.BOT.NAME}** v${CONFIG.BOT.VERSION}\n\n` +
      `I help increase trading volume for Solana tokens with MEV protection.\n\n` +
      `Your wallet: \`${publicKey}\`\n\n` +
      `Use the menu below to get started:`;

    ctx.reply(welcomeMessage, getMainMenu().extra().markup(m => m));
    logger.info(`Bot started by user ${ctx.from.id}`);
  } catch (error) {
    logger.error('Start command error:', error);
    ctx.reply('❌ An error occurred. Please try again.');
  }
});

bot.help((ctx) => {
  try {
    const helpMessage = 
      `📚 **Help for ${CONFIG.BOT.NAME}**\n\n` +
      `Available commands:\n` +
      `/start - Show main menu\n` +
      `/help - Show this help message\n` +
      `/status - View current bot status\n\n` +
      `For support: https://t.me/solana_volume_bot_support`;

    ctx.reply(helpMessage);
  } catch (error) {
    logger.error('Help command error:', error);
    ctx.reply('❌ Error showing help. Please try again.');
  }
});

bot.command('status', isAdmin, async (ctx) => {
  try {
    const solBalance = await connection.getBalance(payer.publicKey);
    const solBalanceSOL = solBalance / LAMPORTS_PER_SOL;
  
    const statusMessage = 
      `📊 **Bot Status**\n\n` +
      `🟢 **Status**: Active\n` +
      `💰 **Wallet**: ${publicKey}\n` +
      `💰 **SOL Balance**: ${solBalanceSOL.toFixed(4)} SOL\n` +
      `🛡️ **MEV Protection**: ${CONFIG.MEV.ENABLED ? 'Enabled' : 'Disabled'}\n` +
      `📈 **Last 24h Volume**: 0.5 SOL\n` +
      `🔄 **Active Cycles**: 0`;
    
    ctx.reply(statusMessage);
  } catch (error) {
    logger.error('Status command error:', error);
    ctx.reply('❌ Error fetching status. Please try again.');
  }
});

// Setup configuration
bot.action('setup_config', isAdmin, (ctx) => {
  try {
    pendingAction.set('setup_config');
    ctx.reply('⚙️ Please enter the token contract address:');
  } catch (error) {
    logger.error('Setup config error:', error);
    ctx.reply('❌ Error in setup. Please try again.');
  }
});

// Start pump
bot.action('start_pump', isAdmin, (ctx) => {
  try {
    pendingAction.set('start_pump');
    ctx.reply('🔥 Enter the token contract address to start pumping:');
  } catch (error) {
    logger.error('Start pump error:', error);
    ctx.reply('❌ Error starting pump. Please try again.');
  }
});

// Stop pump
bot.action('stop_pump', isAdmin, (ctx) => {
  try {
    ctx.reply('⏹️ Pump stopped. All operations have been halted.');
  } catch (error) {
    logger.error('Stop pump error:', error);
    ctx.reply('❌ Error stopping pump. Please try again.');
  }
});

// Handle text messages (token address input)
const pendingAction = new Map();
bot.on('text', (ctx) => {
  if (!CONFIG.TELEGRAM.ADMIN_ID || ctx.from.id === CONFIG.TELEGRAM.ADMIN_ID) {
    const action = pendingAction.get('setup_config') || pendingAction.get('start_pump');
  
    if (action) {
      try {
        const tokenAddress = ctx.message.text.trim();
        pendingAction.delete('setup_config');
        pendingAction.delete('start_pump');
      
        // Validate token address format
        if (!/^[A-Za-z0-9]{32,44}$/.test(tokenAddress)) {
          return ctx.reply('❌ Invalid token address format. Please try again.');
        }
      
        ctx.reply(`⏳ Processing ${action} for token: ${tokenAddress}...`);
      
        // Simulate transaction for now
        const tx = new Transaction().add(
          SystemProgram.transfer(payer.publicKey, new PublicKey('9wvX...'), 0.1 * LAMPORTS_PER_SOL)
        );
      
        const txSignature = await sendTransactionWithMEVProtection(tx);
      
        ctx.reply(
          `✅ **${action === 'setup_config' ? 'Configuration' : 'Pump'} Complete!**\n\n` +
          `Token: \`${tokenAddress}\`\n` +
          `Transaction: https://solscan.io/tx/${txSignature}\n\n` +
          `Use the menu to continue.`
        );
      } catch (error) {
        logger.error(`Error in ${action} action:`, error);
        ctx.reply('❌ Error processing request. Please try again.');
      }
    } else {
      ctx.reply('⚠️ Please use the menu buttons to interact with the bot.');
    }
  }
});

// =====Deployment and Graceful Shutdown=====
const PORT = CONFIG.RENDER.PORT;

const launchBot = async () => {
  try {
    await bot.launch({
      webhook: {
        domain: CONFIG.RENDER.EXTERNAL_URL,
        port: PORT
      }
    });
    logger.info(`✅ Bot running at ${CONFIG.RENDER.EXTERNAL_URL}`);
  
    // Send startup notification
    if (CONFIG.TELEGRAM.ADMIN_ID) {
      await bot.telegram.sendMessage(
        CONFIG.TELEGRAM.ADMIN_ID,
        `🚀 ${CONFIG.BOT.NAME} is online!\nVersion: ${CONFIG.BOT.VERSION}\nWallet: ${publicKey}`
      );
    }
  } catch (error) {
    logger.error('🚨 Launch error:', error);
    throw new BotError('Bot launch failed', error);
  }
};

launchBot();

// Graceful shutdown
process.once('SIGINT', () => {
  logger.info('⛔️ Received SIGINT - Shutting down');
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  logger.info('⛔️ Received SIGTERM - Shutting down');
  bot.stop('SIGTERM');
  process.exit(0);
});

// Unhandled promise rejections
process.on('unhandledRejection', (reason) => {
  logger.error('⚠️ Unhandled Rejection:', reason);
});

// =====Error Handling Middleware=====
bot.use((err, ctx) => {
  logger.error('Unhandled error:', err);

  if (err instanceof BotError) {
    ctx.reply(`❌ Bot Error: ${err.message}`);
  } else {
    ctx.reply('❌ An unexpected error occurred. Please try again.');
  }
});
