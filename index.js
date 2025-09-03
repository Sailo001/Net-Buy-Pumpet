// === Net-Buy-Pumpet Bot ===
// Telegram crypto pump bot with multi-wallet + MEV protection
// Corrected and cleaned version

import { Telegraf, Markup } from 'telegraf';
import { createServer } from 'http';
import dotenv from 'dotenv';
import {
  getRaydiumPoolInfo,
  buyTokenSingle,
  buyTokenMEVProtected,
  sellTokenSingle,
  sellTokenMEVProtected
} from './services/trading.js';
import {
  getMainMenu,
  getSetupMenu,
  getAdvancedMenu,
  getStatusMenu,
  showCurrentConfig,
  getSetupSummary
} from './services/menus.js';
import {
  SETUP_STEPS,
  getCurrentStep,
  getUserData,
  setUserStep,
  clearUserSetup
} from './services/session.js';
import multiWallet from './services/multiwallet.js';
import mevProtection from './services/mevProtection.js';

dotenv.config();

const ADMIN = process.env.ADMIN_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN || !ADMIN) {
  console.error('❌ BOT_TOKEN or ADMIN_ID missing in environment!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// === GLOBAL STATE ===
let session = {
  mint: null,
  buySol: null,
  sellPct: null,
  delaySec: null,
  multiBuys: null,
  mevProtection: false,
  multiWallet: false,
  buyScale: 1.0
};

let running = false;
let isShuttingDown = false;
// === TELEGRAM COMMAND HANDLERS ===

// Start command
bot.start(ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const welcomeMsg = [
    '🤖 **Welcome to Net-Buy-Pumpet!**',
    '',
    '🚀 **Professional Solana Token Pump Bot**',
    '💎 Automated buying/selling with Raydium integration',
    '🛡️ MEV Protection & Multi-Wallet Orchestration',
    '',
    '📊 **Current Status:**',
    `🎯 Token: ${session.mint ? `${session.mint.slice(0, 8)}...` : '❌ Not configured'}`,
    `🔄 Bot: ${running ? '🟢 Active' : '🔴 Stopped'}`,
    `🎭 Wallets: ${multiWallet.getActiveWallets().length} loaded`,
    '',
    '👇 **Choose an action below:**'
  ].join('\n');

  ctx.reply(welcomeMsg, { ...getMainMenu(), parse_mode: 'Markdown' });
});

// Setup command
bot.command('setup', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  clearUserSetup(ctx.from.id);
  setUserStep(ctx.from.id, SETUP_STEPS.WAITING_CONTRACT);

  ctx.reply(
    '🔧 **Pump Setup - Step 1/5**\n\n' +
    '🎯 **Enter Token Contract Address:**\n' +
    '📝 Please send the contract address (mint) of the token you want to pump.\n\n' +
    '💡 Example: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`',
    { ...getSetupMenu(), parse_mode: 'Markdown' }
  );
});

// Status command
bot.command('status', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const statusMsg = [
    showCurrentConfig(),
    '',
    `🔄 **Bot Status:** ${running ? '🟢 Pumping Active' : '🔴 Stopped'}`,
    `🎭 Wallets: ${multiWallet.getActiveWallets().length} loaded`
  ].join('\n');

  ctx.reply(statusMsg, { ...getStatusMenu(), parse_mode: 'Markdown' });
});

// Advanced command
bot.command('advanced', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const advancedMsg = [
    '🛡️ **Advanced Features Control**',
    '',
    '🎛️ **Current Settings:**',
    `🛡️ MEV Protection: ${session.mevProtection ? '🟢 ON' : '🔴 OFF'}`,
    `🎭 Multi-Wallet: ${session.multiWallet ? '🟢 ON' : '🔴 OFF'}`,
    '',
    '⚙️ **Toggle settings or run analysis below:**'
  ].join('\n');

  ctx.reply(advancedMsg, { ...getAdvancedMenu(), parse_mode: 'Markdown' });
});

// Help command
bot.command('help', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const helpMsg = [
    '📖 **Net-Buy-Pumpet Help**',
    '',
    '🚀 **Bot Commands:**',
    '• `/start` - Main dashboard',
    '• `/setup` - Configure pump parameters',
    '• `/status` - View current configuration',
    '• `/advanced` - Advanced feature controls',
    '• `/pump` - Start pumping',
    '• `/stop` - Stop pumping',
    '• `/sellall` - Sell all tokens',
    '• `/help` - Show this help',
    '',
    '🔧 **How to Use:**',
    '1. Click "Setup Configuration" to configure your pump',
    '2. Follow the 5-step setup process',
    '3. Enable advanced features with `/advanced`',
    '4. Click "Start Pump" to begin trading',
    '5. Monitor transactions in real-time',
    '',
    '💡 **Advanced Features:**',
    '• 🛡️ MEV Protection - Jito private mempool',
    '• 🎭 Multi-Wallet - Coordinate multiple wallets'
  ].join('\n');

  ctx.reply(helpMsg, { ...getMainMenu(), parse_mode: 'Markdown' });
});
// === SETUP FLOW HANDLER ===
bot.on('text', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const userId = ctx.from.id;
  const step = getCurrentStep(userId);
  const text = ctx.message.text.trim();

  // Step 1: Contract address
  if (step === SETUP_STEPS.WAITING_CONTRACT) {
    if (!isValidSolanaAddress(text)) {
      return ctx.reply('❌ Invalid contract address. Please send a valid Solana token mint address.');
    }

    session.mint = text;
    setUserStep(userId, SETUP_STEPS.WAITING_BUY);

    return ctx.reply(
      '🔧 **Pump Setup - Step 2/5**\n\n' +
      '💰 **Enter Buy Amount (SOL per cycle):**\n' +
      '📝 Example: `0.5`',
      { parse_mode: 'Markdown' }
    );
  }

  // Step 2: Buy amount
  if (step === SETUP_STEPS.WAITING_BUY) {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('❌ Invalid amount. Please enter a positive number.');
    }

    session.buySol = amount;
    setUserStep(userId, SETUP_STEPS.WAITING_SELL);

    return ctx.reply(
      '🔧 **Pump Setup - Step 3/5**\n\n' +
      '📈 **Enter Sell Percentage per cycle:**\n' +
      '📝 Example: `50` for 50%',
      { parse_mode: 'Markdown' }
    );
  }

  // Step 3: Sell percentage
  if (step === SETUP_STEPS.WAITING_SELL) {
    const pct = parseFloat(text);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      return ctx.reply('❌ Invalid percentage. Please enter a number between 0 and 100.');
    }

    session.sellPct = pct;
    setUserStep(userId, SETUP_STEPS.WAITING_DELAY);

    return ctx.reply(
      '🔧 **Pump Setup - Step 4/5**\n\n' +
      '⏱️ **Enter Delay between cycles (seconds):**\n' +
      '📝 Example: `30`',
      { parse_mode: 'Markdown' }
    );
  }

  // Step 4: Delay
  if (step === SETUP_STEPS.WAITING_DELAY) {
    const delay = parseInt(text);
    if (isNaN(delay) || delay < 1) {
      return ctx.reply('❌ Invalid delay. Please enter a number greater than 0.');
    }

    session.delaySec = delay;
    setUserStep(userId, SETUP_STEPS.WAITING_MULTI);

    return ctx.reply(
      '🔧 **Pump Setup - Step 5/5**\n\n' +
      '🔄 **Enter Multi-Buy Count (per cycle):**\n' +
      '📝 Example: `3`',
      { parse_mode: 'Markdown' }
    );
  }

  // Step 5: Multi-buy
  if (step === SETUP_STEPS.WAITING_MULTI) {
    const count = parseInt(text);
    if (isNaN(count) || count < 1 || count > 20) {
      return ctx.reply('❌ Invalid count. Please enter a number between 1 and 20.');
    }

    session.multiBuys = count;
    clearUserSetup(userId);

    return ctx.reply(
      '✅ **Setup Complete!**\n\n' +
      showCurrentConfig(),
      { ...getMainMenu(), parse_mode: 'Markdown' }
    );
  }
});
// === INLINE BUTTON HANDLERS ===

// Main menu
bot.action('main_menu', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  ctx.editMessageText(
    '🏠 **Main Menu**\n\n' +
    showCurrentConfig(),
    { ...getMainMenu(), parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

// Setup menu
bot.action('setup_menu', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  ctx.editMessageText(
    '🔧 **Setup Configuration**\n\n' +
    showCurrentConfig(),
    { ...getSetupMenu(), parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

// Advanced menu
bot.action('advanced_menu', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  ctx.editMessageText(
    '🛡️ **Advanced Features**\n\n' +
    `MEV Protection: ${session.mevProtection ? '🟢 ON' : '🔴 OFF'}\n` +
    `Multi-Wallet: ${session.multiWallet ? '🟢 ON' : '🔴 OFF'}`,
    { ...getAdvancedMenu(), parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

// Status refresh
bot.action('refresh_status', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  ctx.editMessageText(
    '📊 **Current Status**\n\n' +
    showCurrentConfig(),
    { ...getStatusMenu(), parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery();
});

// Sell all confirm
bot.action('sell_all_confirm', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  ctx.editMessageText(
    '⚠️ **Confirm Emergency Sell**\n\n' +
    'Do you want to sell all tokens immediately?',
    {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, Sell All', 'sell_all_now')],
        [Markup.button.callback('❌ Cancel', 'main_menu')]
      ]),
      parse_mode: 'Markdown'
    }
  );
  ctx.answerCbQuery();
});

// Sell all execution
bot.action('sell_all_now', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (!session.mint) {
    return ctx.reply('❌ No token configured!', getMainMenu());
  }

  try {
    let results;
    if (session.mevProtection) {
      results = await sellTokenMEVProtected(session.mint, 100);
    } else {
      results = await sellTokenSingle(session.mint, 100);
    }

    if (Array.isArray(results)) {
      const txLinks = results.map((tx, i) => `[Tx${i + 1}](https://solscan.io/tx/${tx})`).join(' ');
      ctx.reply(
        '✅ **Emergency Sell Complete!**\n\n' +
        `📊 Transactions: ${txLinks}`,
        { ...getMainMenu(), parse_mode: 'Markdown' }
      );
    } else {
      ctx.reply(
        '✅ **Emergency Sell Complete!**\n\n' +
        `📊 [View Transaction](https://solscan.io/tx/${results})`,
        { ...getMainMenu(), parse_mode: 'Markdown' }
      );
    }
  } catch (err) {
    ctx.reply(`❌ **Sell Failed:** ${err.message}`, getMainMenu());
  }

  ctx.answerCbQuery();
});

// Toggle MEV protection
bot.action('toggle_mev', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  session.mevProtection = !session.mevProtection;
  ctx.editMessageText(
    '🛡️ **Advanced Features Updated**\n\n' +
    `MEV Protection: ${session.mevProtection ? '🟢 ON' : '🔴 OFF'}\n` +
    `Multi-Wallet: ${session.multiWallet ? '🟢 ON' : '🔴 OFF'}`,
    { ...getAdvancedMenu(), parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery(`MEV Protection ${session.mevProtection ? 'enabled' : 'disabled'}`);
});

// Toggle multi-wallet
bot.action('toggle_multiwallet', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  session.multiWallet = !session.multiWallet;
  ctx.editMessageText(
    '🛡️ **Advanced Features Updated**\n\n' +
    `MEV Protection: ${session.mevProtection ? '🟢 ON' : '🔴 OFF'}\n` +
    `Multi-Wallet: ${session.multiWallet ? '🟢 ON' : '🔴 OFF'}`,
    { ...getAdvancedMenu(), parse_mode: 'Markdown' }
  );
  ctx.answerCbQuery(`Multi-Wallet ${session.multiWallet ? 'enabled' : 'disabled'}`);
});
// === MEV ANALYSIS ===
bot.action('analyze_mev', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  if (!session.mint) {
    ctx.answerCbQuery('Set a token first!');
    return;
  }

  ctx.reply('🔍 **Analyzing MEV Activity...**', { parse_mode: 'Markdown' });

  try {
    const analysis = await mevProtection.detectMEVActivity(session.mint);

    const msg = [
      '🔍 **MEV Analysis Results:**',
      `🎯 Token: ${session.mint.slice(0, 8)}...`,
      `📊 Risk Score: ${analysis.riskScore.toFixed(2)}/1.0`,
      `🛡️ Recommended: ${analysis.recommendation.toUpperCase()}`,
      '',
      '**Detected Indicators:**',
      `🏃 Front-runs: ${analysis.indicators.frontRuns}`,
      `🥪 Sandwiches: ${analysis.indicators.sandwiches}`,
      `📋 Copy Trades: ${analysis.indicators.copyTrades}`,
      `📊 Total TXs: ${analysis.indicators.totalTxs}`,
      '',
      analysis.riskScore > 0.7
        ? '⚠️ HIGH MEV RISK - Use maximum protection!'
        : analysis.riskScore > 0.3
          ? '⚠️ Medium risk - Standard protection recommended'
          : '✅ Low risk - Minimal protection needed'
    ].join('\n');

    ctx.reply(msg, { ...getAdvancedMenu(), parse_mode: 'Markdown' });
  } catch (err) {
    ctx.reply(
      `❌ **MEV Analysis Failed:** ${err.message}`,
      { ...getAdvancedMenu(), parse_mode: 'Markdown' }
    );
  }

  ctx.answerCbQuery();
});

// === MULTIWALLET STATUS ===
bot.action('multiwallet_status', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const wallets = multiWallet.getActiveWallets();
  const activeCount = wallets.filter(w => w.active).length;

  const lines = [
    '🎭 **Multi-Wallet Status**',
    `👥 Total Wallets: ${wallets.length}`,
    `🟢 Active Wallets: ${activeCount}`,
    ''
  ];

  wallets.forEach((wallet, i) => {
    lines.push(
      `${i + 1}. ${wallet.role.toUpperCase()}`,
      `   📍 ${wallet.keypair.publicKey.toString().slice(0, 8)}...${wallet.keypair.publicKey.toString().slice(-4)}`,
      `   🔄 Status: ${wallet.active ? '🟢 Active' : '🔴 Inactive'}`,
      ''
    );
  });

  lines.push(
    '💡 Multi-Wallet Benefits:',
    '• Natural trading patterns',
    '• Distributed risk across wallets',
    '• Harder to detect as coordinated',
    '• Better volume distribution'
  );

  ctx.reply(lines.join('\n'), { ...getAdvancedMenu(), parse_mode: 'Markdown' });
  ctx.answerCbQuery();
});

// === PUMP LOOP ===
async function startPumpLoop(ctx) {
  let buyAmount = session.buySol;
  let cycle = 0;

  try {
    const mevAnalysis = await mevProtection.detectMEVActivity(session.mint);
    await ctx.telegram.sendMessage(
      ADMIN,
      `🛡️ MEV Analysis Complete\nRisk: ${mevAnalysis.riskScore.toFixed(2)}\nProtection: ${mevAnalysis.recommendation.toUpperCase()}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('MEV analysis failed at start:', err);
  }

  while (running && !isShuttingDown) {
    try {
      cycle++;
      await ctx.telegram.sendMessage(
        ADMIN,
        `🔄 **Cycle ${cycle} Starting** - ${buyAmount.toFixed(4)} SOL`,
        { parse_mode: 'Markdown' }
      );

      for (let i = 0; i < session.multiBuys; i++) {
        if (!running || isShuttingDown) break;

        try {
          if (session.multiWallet && multiWallet.getActiveWallets().length > 1) {
            const results = await multiWallet.executeCoordinatedBuy(session.mint, buyAmount, session.mevProtection);

            for (const r of results) {
              if (r.tx) {
                await ctx.telegram.sendMessage(
                  ADMIN,
                  `✅ ${r.wallet.toUpperCase()} - ${r.amount.toFixed(4)} SOL\n📊 [Tx](https://solscan.io/tx/${r.tx})`,
                  { parse_mode: 'Markdown' }
                );
              } else {
                await ctx.telegram.sendMessage(
                  ADMIN,
                  `❌ ${r.wallet.toUpperCase()} failed: ${r.error}`,
                  { parse_mode: 'Markdown' }
                );
              }
            }
          } else if (session.mevProtection) {
            const txs = await buyTokenMEVProtected(session.mint, buyAmount);

            if (Array.isArray(txs)) {
              for (let j = 0; j < txs.length; j++) {
                await ctx.telegram.sendMessage(
                  ADMIN,
                  `✅ Buy ${i + 1}.${j + 1}/${session.multiBuys} Protected\n📊 [Tx](https://solscan.io/tx/${txs[j]})`,
                  { parse_mode: 'Markdown' }
                );
              }
            } else {
              await ctx.telegram.sendMessage(
                ADMIN,
                `✅ Buy ${i + 1}/${session.multiBuys} Protected\n📊 [Tx](https://solscan.io/tx/${txs})`,
                { parse_mode: 'Markdown' }
              );
            }
          } else {
            const tx = await buyTokenSingle(session.mint, buyAmount);
            await ctx.telegram.sendMessage(
              ADMIN,
              `✅ Buy ${i + 1}/${session.multiBuys} Standard\n📊 [Tx](https://solscan.io/tx/${tx})`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (err) {
          await ctx.telegram.sendMessage(
            ADMIN,
            `❌ Buy ${i + 1} Failed: ${err.message}`,
            { parse_mode: 'Markdown' }
          );
        }

        if (i < session.multiBuys - 1) {
          await new Promise(res => setTimeout(res, 1000));
        }
      }

      // Selling logic
      if (session.sellPct > 0 && running && !isShuttingDown) {
        try {
          if (session.mevProtection) {
            const results = await sellTokenMEVProtected(session.mint, session.sellPct);
            if (Array.isArray(results)) {
              for (let j = 0; j < results.length; j++) {
                await ctx.telegram.sendMessage(
                  ADMIN,
                  `📈 Sell ${j + 1}/${results.length} - ${session.sellPct}% Protected\n📊 [Tx](https://solscan.io/tx/${results[j]})`,
                  { parse_mode: 'Markdown' }
                );
              }
            } else {
              await ctx.telegram.sendMessage(
                ADMIN,
                `📈 Sold ${session.sellPct}% Protected\n📊 [Tx](https://solscan.io/tx/${results})`,
                { parse_mode: 'Markdown' }
              );
            }
          } else {
            const tx = await sellTokenSingle(session.mint, session.sellPct);
            await ctx.telegram.sendMessage(
              ADMIN,
              `📈 Sold ${session.sellPct}% Standard\n📊 [Tx](https://solscan.io/tx/${tx})`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (err) {
          await ctx.telegram.sendMessage(
            ADMIN,
            `❌ Sell Failed: ${err.message}`,
            { parse_mode: 'Markdown' }
          );
        }
      }

      // Adjust buy amount and delay
      buyAmount *= session.buyScale;
      const baseDelay = session.delaySec * 1000;
      const jitter = 0.8 + Math.random() * 0.4;
      const delay = Math.max(500, baseDelay * jitter);

      await new Promise(res => setTimeout(res, delay));
    } catch (err) {
      await ctx.telegram.sendMessage(
        ADMIN,
        `❌ Cycle ${cycle} Error: ${err.message}`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  await ctx.telegram.sendMessage(
    ADMIN,
    '⏹️ Pump Stopped\n\nUse /pump to start again.',
    { ...getMainMenu(), parse_mode: 'Markdown' }
  );
}
// === COMMANDS ===

// Start pump manually
bot.command('pump', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (running) return ctx.reply('⏳ Pump already running.', getMainMenu());
  if (!session.mint) return ctx.reply('❌ No token configured. Use Setup first!', getMainMenu());

  running = true;

  const msg = [
    '🔥 **PUMP STARTED!**',
    `🎯 Token: ${session.mint.slice(0, 8)}...`,
    `💰 Buy: ${session.buySol} SOL per cycle`,
    `📈 Sell: ${session.sellPct}% per cycle`,
    `⏱️ Delay: ${session.delaySec}s`,
    `🔄 Multi-Buys: ${session.multiBuys}`,
    `🛡️ MEV Protection: ${session.mevProtection ? 'ON' : 'OFF'}`,
    `🎭 Multi-Wallet: ${session.multiWallet ? 'ON' : 'OFF'}`,
    '',
    '📈 Monitoring transactions...'
  ].join('\n');

  const menu = Markup.inlineKeyboard([
    [Markup.button.callback('⏹️ Stop Pump', 'stop_pump')],
    [Markup.button.callback('📊 View Status', 'refresh_status')],
    [Markup.button.callback('💰 Emergency Sell All', 'sell_all_confirm')],
    [Markup.button.callback('🛡️ Advanced Settings', 'advanced_menu')],
    [Markup.button.callback('🏠 Main Menu', 'main_menu')]
  ]);

  ctx.reply(msg, { ...menu, parse_mode: 'Markdown' });
  startPumpLoop(ctx);
});

// Stop pump manually
bot.command('stop', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (!running) return ctx.reply('⏹️ Pump not running.', getMainMenu());

  running = false;
  ctx.reply(
    '⏹️ Pump will stop after current cycle.\n\nUse the menu below for actions.',
    { ...getMainMenu(), parse_mode: 'Markdown' }
  );
});

// Emergency sell all
bot.command('sellall', async ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (!session.mint) return ctx.reply('❌ No token configured!', getMainMenu());

  try {
    let results;
    if (session.mevProtection) {
      results = await sellTokenMEVProtected(session.mint, 100);
    } else {
      results = await sellTokenSingle(session.mint, 100);
    }

    if (Array.isArray(results)) {
      const links = results.map((tx, i) => `[Tx${i + 1}](https://solscan.io/tx/${tx})`).join(' ');
      ctx.reply(`✅ **All Tokens Sold!**\n\n📊 Transactions: ${links}`, { ...getMainMenu(), parse_mode: 'Markdown' });
    } else {
      ctx.reply(`✅ **All Tokens Sold!**\n\n📊 [View Tx](https://solscan.io/tx/${results})`, { ...getMainMenu(), parse_mode: 'Markdown' });
    }
  } catch (err) {
    ctx.reply(`❌ **Sell Failed:** ${err.message}`, getMainMenu());
  }
});

// Fallback for unknown messages
bot.on('message', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;

  const currentStep = getCurrentStep(ctx.from.id);
  if (!currentStep && ctx.message.text && !ctx.message.text.startsWith('/')) {
    ctx.reply('🤖 Use the menu below or send `/help`.', getMainMenu());
  }
});

// === ERROR HANDLING ===
bot.catch((err, ctx) => {
  console.error('Bot error:', err);

  if (err.code === 409 || err.response?.error_code === 409) {
    console.log('❌ Bot conflict detected: another instance running. Exiting...');
    gracefulShutdown();
    return;
  }

  if (err.response?.error_code === 429) {
    console.log('⚠️ Rate limited, backing off...');
    return;
  }

  if (ctx) {
    try {
      ctx.reply(`❌ Bot Error: ${err.message}`, { ...getMainMenu(), parse_mode: 'Markdown' });
    } catch (replyErr) {
      console.error('Failed to send error message:', replyErr);
    }
  }
});
// === HEALTH CHECK SERVER ===
const port = process.env.PORT || 3000;
const server = createServer((req, res) => {
  if (res.headersSent) return;

  try {
    if (req.url === '/webhook' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        if (res.headersSent) return;
        try {
          const update = JSON.parse(body);
          bot.handleUpdate(update);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
        } catch (err) {
          console.error('Webhook processing error:', err);
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Bad Request');
          }
        }
      });
    } else if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        bot_running: !isShuttingDown,
        pump_active: running,
        configured: !!session.mint,
        mev_protection: session.mevProtection,
        multi_wallet: session.multiWallet,
        wallet_count: multiWallet.getActiveWallets().length,
        timestamp: new Date().toISOString()
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  } catch (err) {
    console.error('Server error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }
});

server.listen(port, () => {
  console.log(`🌐 Health check server running on port ${port}`);
});

// === GRACEFUL SHUTDOWN ===
async function gracefulShutdown() {
  if (isShuttingDown) return;

  isShuttingDown = true;
  running = false;

  console.log('🔄 Initiating graceful shutdown...');
  try {
    await bot.telegram.sendMessage(ADMIN, '🛑 Bot shutting down...');
  } catch (err) {
    console.error('Failed to send shutdown message:', err);
  }

  try {
    await bot.stop();
    console.log('✅ Bot stopped successfully');
  } catch (err) {
    console.error('Error stopping bot:', err);
  }

  setTimeout(() => {
    console.log('👋 Process exiting');
    process.exit(0);
  }, 2000);
}

// === BOT STARTUP ===
async function startBot() {
  try {
    const useWebhooks = process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_URL;

    if (useWebhooks) {
      const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook`;
      await bot.telegram.setWebhook(webhookUrl);
      console.log(`🔗 Webhook set: ${webhookUrl}`);
    } else {
      await bot.launch({
        dropPendingUpdates: true,
        allowedUpdates: ['message', 'callback_query']
      });
      console.log('🔄 Using polling mode');
    }

    console.log('✅ Net-Buy-Pumpet bot running!');
    console.log(`🎭 Multi-wallet system: ${multiWallet.getActiveWallets().length} wallets loaded`);

    try {
      await bot.telegram.sendMessage(
        ADMIN,
        '🤖 **Net-Buy-Pumpet deployed!**\n\n' +
        `🛡️ MEV Protection: Ready\n` +
        `🎭 Multi-Wallet: ${multiWallet.getActiveWallets().length} wallets\n\n` +
        `Send /start to begin.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('Failed to send startup message:', err);
    }
  } catch (err) {
    console.error('❌ Failed to start bot:', err);

    if (err.code === 409 || err.response?.error_code === 409) {
      console.log('💡 Another instance running. Solutions:');
      console.log('1. Stop other instances');
      console.log('2. Wait 60s and retry');
      console.log('3. Use webhooks in production');
    }

    process.exit(1);
  }
}

// === SIGNAL HANDLERS ===
process.once('SIGINT', () => {
  console.log('📨 SIGINT received');
  gracefulShutdown();
});
process.once('SIGTERM', () => {
  console.log('📨 SIGTERM received');
  gracefulShutdown();
});
process.on('uncaughtException', err => {
  console.error('💥 Uncaught Exception:', err);
  gracefulShutdown();
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start bot
startBot();
