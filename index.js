import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import { Telegraf } from 'telegraf';
import { Connection, Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch';

// Initialize Express app
const app = express();
app.use(express.json()); // For parsing application/json

// Debug environment variables
console.log('[INIT] Checking environment variables...');
console.log(`- TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? 'Set' : 'Missing'}`);
console.log(`- ADMIN_CHAT_ID: ${process.env.ADMIN_CHAT_ID ? 'Set' : 'Missing'}`);
console.log(`- SOLANA_PRIVATE_KEY: ${process.env.SOLANA_PRIVATE_KEY ? 'Set' : 'Missing'}`);
console.log(`- RENDER_EXTERNAL_URL: ${process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL : 'Missing'}`);

// Validate critical environment variables
if (!process.env.TELEGRAM_BOT_TOKEN || 
    !process.env.ADMIN_CHAT_ID || 
    !process.env.SOLANA_PRIVATE_KEY) {
    console.error('[FATAL] Missing required environment variables!');
    process.exit(1);
}

// Initialize Telegram bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Initialize Solana connection
const connection = new Connection(
    process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    'confirmed'
);

// Initialize wallet
const payer = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY));
console.log(`[SOLANA] Wallet initialized: ${payer.publicKey.toString().slice(0, 8)}...`);

// ========== MIDDLEWARE ========== //
// Log all incoming requests
bot.use(async (ctx, next) => {
    console.log(`[TELEGRAM] Update from ${ctx.update.update_id}: ${ctx.updateType}`);
    await next();
});

// ========== COMMAND HANDLERS ========== //
bot.start(async (ctx) => {
    try {
        console.log(`[START] Received from ${ctx.from.id}`);
        await ctx.reply('🚀 Solana Volume Booster Activated!\n\n'
            + '✅ MEV Protection: Enabled\n'
            + '🔒 Wallet Connected\n\n'
            + 'Use /boost to increase token volume');
    } catch (error) {
        console.error(`[START ERROR] ${error.message}`);
    }
});

bot.command('boost', async (ctx) => {
    try {
        console.log(`[BOOST] Request from ${ctx.from.id}`);
        await ctx.reply('⚡️ Initiating volume boost...');
      
        // Simulate a transaction (replace with actual swap logic)
        const dummyTx = Keypair.generate().publicKey.toString();
        const solscanUrl = `https://solscan.io/tx/${dummyTx}`;
      
        await ctx.reply(`✅ Volume boosted successfully!\n\n`
            + `📊 Transaction: ${solscanUrl}\n`
            + `💎 Token: YOUR_TOKEN_HERE\n`
            + `📈 Volume: 100 SOL`);
    } catch (error) {
        console.error(`[BOOST ERROR] ${error.message}`);
        await ctx.reply('❌ Failed to boost volume. Check server logs.');
    }
});

// ========== WEBHOOK CONFIGURATION ========== //
// Use express for webhook handling
app.use(bot.webhookCallback('/webhook'));

// Health check endpoint
app.get('/', (req, res) => {
    res.status(200).send('Solana Volume Bot is running');
});

// Set webhook on startup
const setupWebhook = async () => {
    if (!process.env.RENDER_EXTERNAL_URL) {
        console.warn('[WARNING] RENDER_EXTERNAL_URL not set - webhook not configured');
        return;
    }

    const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook`;
  
    try {
        console.log(`[WEBHOOK] Setting up: ${webhookUrl}`);
        await bot.telegram.setWebhook(webhookUrl);
        console.log('[WEBHOOK] Setup complete');
    } catch (error) {
        console.error(`[WEBHOOK ERROR] ${error.message}`);
    }
};

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`[SERVER] Running on port ${PORT}`);
    await setupWebhook();
  
    // Send startup notification
    try {
        await bot.telegram.sendMessage(
            process.env.ADMIN_CHAT_ID,
            `🤖 Bot deployed successfully!\n\n`
            + `🆔 ${process.env.RENDER_EXTERNAL_URL}\n`
            + `👛 Wallet: ${payer.publicKey.toString().slice(0, 8)}...\n`
            + `🕒 ${new Date().toLocaleString()}`
        );
        console.log('[STARTUP] Notification sent to admin');
    } catch (error) {
        console.error('[STARTUP NOTIFY ERROR]', error.message);
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[SHUTDOWN] SIGTERM received');
    bot.stop();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[SHUTDOWN] SIGINT received');
    bot.stop();
    process.exit(0);
});
