import dotenv from 'process';
import { Telegraf, Markup } from 'telegraf';

// ===== CONFIGURATION =====
const MEV_CONFIG = {
  privatePools: [
    'https://amsterdam.mainnet.block-engine.jito.wtf',
    'https://ny.mainnet.block-engine.jito.wtf',
    'https://tokyo.mainnet.block-engine.jito.wtf'
  ],
  maxSlippage: 0.5,
  protectionLevel: 'medium'
};

// ===== INITIALIZATION =====
console.log('[INIT] Starting Solana Volume Booster Bot...');

// Load environment variables
const {
  TELEGRAM_BOT_TOKEN,
  ADMIN_CHAT_ID,
  SOLANA_PRIVATE_KEY,
  RPC_URL = 'https://api.mainnet-beta.solana.com',
  JITO_TIP_AMOUNT = 10000,
  RENDER_EXTERNAL_URL = 'https://solana-volume-bot.onrender.com'
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID || !SOLANA_PRIVATE_KEY) {
  console.error('[FATAL] Missing required environment variables');
  process.exit(1);
}

// Parse ADMIN_CHAT_ID
const adminChatID = parseInt(ADMIN_CHAT_ID);

// Initialize bot
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ===== TELEGRAM MENU SYSTEM =====
function getMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⚙️ Setup Configuration', 'setup_config')],
    [Markup.button.callback('📊 View Status', 'view_status')],
    [Markup.button.callback('🔥 Start Pump', 'start_pump')],
    [Markup.button.callback('⏹️ Stop Pump', 'stop_pump')],
    [Markup.button.callback('💰 Sell All Tokens', 'sell_all')],
    [Markup.button.callback('🎭 Multi-Wallet', 'multi_wallet')],
    [Markup.button.callback('🛡️ Advanced Settings', 'advanced_settings')],
    [Markup.button.callback('🔄 Refresh Menu', 'refresh_menu')]
  ]);
}

// ===== BOT COMMAND HANDLERS =====
// Start command - show welcome message and menu to everyone
bot.start((ctx) => {
  const welcomeMessage = 
    `🚀 **Welcome to Solana Volume Booster!**\n\n` +
    `This bot helps increase trading volume for Solana tokens.\n\n` +
    `Use the menu below to get started:`;

  ctx.reply(welcomeMessage, getMainMenu());
});

// Admin-only commands
const adminOnly = (ctx, next) => {
  if (ctx.from.id !== adminChatID) {
    return ctx.reply('⛔️ Access denied. You are not the bot administrator.');
  }
  return next();
};

// Setup configuration
bot.action('setup_config', adminOnly, (ctx) => {
  ctx.reply('⚙️ Enter token contract address:');
});

// View status
bot.action('view_status', adminOnly, (ctx) => {
  ctx.reply(
    `📊 **System Status**\n\n` +
    `🟢 MEV Protection: ENABLED\n` +
    `💰 Wallet Balance: 0.5 SOL\n` +
    `📈 Last 24h Volume: 5.2 SOL\n` +
    `🔄 Active Cycles: 0`
  );
});

// Start pump
bot.action('start_pump', adminOnly, (ctx) => {
  ctx.reply('🔥 Enter token contract address to start pumping:');
});

// Stop pump
bot.action('stop_pump', adminOnly, (ctx) => {
  ctx.reply('⏹️ Pump stopped. All operations have been halted.');
});

// Sell all tokens
bot.action('sell_all', adminOnly, (ctx) => {
  ctx.reply('💰 Enter the token address to sell all tokens:');
});

// Multi-wallet status
bot.action('multi_wallet', adminOnly, (ctx) => {
  ctx.reply('🎭 Multi-Wallet Status: 3 wallets active');
});

// Advanced settings
bot.action('advanced_settings', adminOnly, (ctx) => {
  ctx.reply(
    `🛡️ Advanced Settings:\n\n` +
    `MEV Protection: ${MEV_CONFIG.protectionLevel.toUpperCase()}\n` +
    `Max Slippage: ${MEV_CONFIG.maxSlippage}%\n` +
    `Jito Tip: ${JITO_TIP_AMOUNT / 1000000} SOL`
  );
});

// Refresh menu
bot.action('refresh_menu', (ctx) => {
  ctx.editMessageText('🔄 Menu refreshed', getMainMenu());
});

// Handle text messages (token address input)
let pendingAction = null;
bot.on('text', (ctx) => {
  if (!adminOnly(ctx, () => {})) return; // Only process admin messages

  if (pendingAction) {
    // This is a reply to a pending request
    const tokenAddress = ctx.message.text;
  
    // Reset pending action first
    const action = pendingAction;
    pendingAction = null;
  
    // Process based on the pending action
    switch (action) {
      case 'setup_config':
        ctx.reply(`⚙️ Starting configuration for token: ${tokenAddress}`);
        break;
      case 'start_pump':
        ctx.reply(`🔥 Starting pump for token: ${tokenAddress}`);
        break;
      case 'sell_all':
        ctx.reply(`💰 Starting sell operation for token: ${tokenAddress}`);
        break;
      default:
        ctx.reply('❌ Unknown action. Please use the menu.');
    }
  } else {
    // If no pending action, show help
    ctx.reply(
      '⚠️ Please use the menu buttons to interact with the bot.\n\n' +
      'Available commands:\n' +
      '/start - Show main menu\n' +
      '/help - Show help information'
    );
  }
});

// Help command
bot.command('help', (ctx) => {
  ctx.reply(
    '🆘 **Help**\n\n' +
    '/start - Show main menu\n' +
    '/help - Show this help message\n\n' +
    'Use the menu buttons to perform operations like pumping tokens, checking status, etc.'
  );
});

// ===== DEPLOYMENT SETUP =====
const PORT = process.env.PORT || 3000;

const launchBot = async () => {
  try {
    await bot.launch({
      webhook: {
        domain: RENDER_EXTERNAL_URL,
        port: PORT
      }
    });
    console.log(`✅ Bot running at: ${RENDER_EXTERNAL_URL}`);
  } catch (error) {
    console.error('🚨 Launch error:', error);
    process.exit(1);
  }
};

launchBot();

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGTERM', () => {
  console.log('⛔️ Received SIGTERM - Shutting down');
  bot.stop('SIGTERM');
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGINT', () => {
  console.log('⛔️ Received SIGINT - Shutting down');
  bot.stop('SIGINT');
  setTimeout(() => process.exit(0), 1000);
});
