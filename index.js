import dotenv from 'process';
import { Telegraf, Markup } from 'telegraf';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch';

// ===== ERROR HANDLING WRAPPER =====
const handleErrors = (fn) => async (ctx, ...args) => {
  try {
    await fn(ctx, ...args);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in ${fn.name}:`, error);
  
    if (ctx && ctx.reply) {
      ctx.reply(`❌ An error occurred: ${error.message}\n\nPlease try again.`);
    }
  }
};

// ===== CONFIGURATION =====
const MEV_CONFIG = {
  privatePools: [
    'https://amsterdam.mainet.block-engine.jito.wtf',
    'https://ny.mainet.block-engine.jito.wtf',
    'https://tokyo.mainet.block-engine.jito.wtf'
  ],
  maxSlippage: 0.5,
  protectionLevel: 'medium'
};

// ===== INITIALIZATION WITH ERROR HANDLING =====
console.log('[INIT] Starting Solana Volume Booster Bot...');

// Load environment variables
const requiredVars = ['TELEGRAM_BOT_TOKEN', 'ADMIN_CHAT_ID', 'SOLANA_PRIVATE_KEY'];
const missingVars = requiredVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error(`[FATAL] Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// Parse ADMIN_CHAT_ID
const adminChatID = parseInt(process.env.ADMIN_CHAT_ID);
if (isNaN(adminChatID)) {
  console.error('[FATAL] ADMIN_CHAT_ID must be a valid number');
  process.exit(1);
}

// Initialize bot and Solana connection
try {
  console.log('Initializing Telegram bot...');
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  console.log('Connecting to Solana...');
  const connection = new Connection(
    process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    'confirmed'
  );

  console.log('Initializing wallet...');
  const payer = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY));
  console.log('Wallet initialized successfully');

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

  // ===== MIDDLEWARE: Admin Check =====
  const adminOnly = (ctx, next) => {
    if (ctx.from.id !== adminChatID) {
      return ctx.reply('⛔️ Access denied. You are not the bot administrator.');
    }
    return next();
  };

  // ===== BOT HANDLERS WITH ERROR WRAPPING =====
  bot.action('setup_config', adminOnly, handleErrors(async (ctx) => {
    pendingTokenAddress = null;
    await ctx.reply('⚙️ Enter token contract address:');
  }));

  // Token address input handler
  let pendingTokenAddress = null;
  bot.on('text', adminOnly, handleErrors(async (ctx) => {
    if (pendingTokenAddress !== null) {
      pendingTokenAddress = ctx.message.text;
      await ctx.reply(`⏳ Starting pump with token: ${pendingTokenAddress}...`);
      await processTokenAddress(pendingTokenAddress, ctx);
      pendingTokenAddress = null;
    } else if (ctx.message.text.startsWith('/pump')) {
      const address = ctx.message.text.split(' ')[1];
      if (address) {
        await ctx.reply(`⏳ Starting pump with token: ${address}...`);
        await processTokenAddress(address, ctx);
      } else {
        await ctx.reply('❌ Please provide the token address: /pump ');
      }
    } else {
      await ctx.reply('⚠️ Please use the menu buttons to interact with the bot.');
    }
  }));

  // ... (other handlers remain the same) ...

  // ===== DEPLOYMENT SETUP =====
  const PORT = process.env.PORT || 3000;
  const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || `https://your-app-name.ondigitalocean.app`;

  const launchBot = async () => {
    try {
      await bot.launch({
        webhook: {
          domain: RENDER_EXTERNAL_URL,
          port: PORT
        }
      });
      console.log(`✅ Bot running at: ${RENDER_EXTERNAL_URL}`);
    
      // Send startup notification
      await bot.telegram.sendMessage(
        adminChatID,
        `🚀 Bot started successfully at ${new Date().toLocaleString()}`
      );
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

  // ===== UNHANDLED REJECTION LISTENER =====
  process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Rejection at:', reason);
  });

  console.log('Bot initialized successfully');
} catch (initError) {
  console.error('🚨 Failed to initialize bot:', initError);
  process.exit(1);
}
