require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram } = require('@solana/web3.js');
const fetch = require('node-fetch');
const { Token, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');
const { buildSwapInstruction } = require('@raydium-io/raydium-sdk');

// === CONFIGURATION ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN = process.env.ADMIN_CHAT_ID;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;

// Use default endpoint for mainnet if not specified
const connection = new Connection();
const payer = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const bot = new Telegraf(TELEGRAM_TOKEN);

let running = false;
let multiBuyMode = false;

let session = {
  mint: '',             // Token mint address (contract address)
  buySol: 0.1,          // SOL per buy
  sellPct: 0,           // % to sell after each buy (0 = aggressive)
  delaySec: 2,          // Delay between rounds (seconds)
  buyScale: 1.1,        // Buy scaling factor per round (+10%)
  multiBuys: 3,         // Buys per round when multi-buy active
};

// === HELPER FUNCTIONS ===

async function getRaydiumPoolInfo(mintAddress) {
  const poolsUrl = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
  const pools = await fetch(poolsUrl).then(r => r.json());
  for (const poolId in pools.official) {
    const pool = pools.official[poolId];
    if (pool.baseMint === mintAddress || pool.quoteMint === mintAddress) {
      pool.id = poolId;
      return pool;
    }
  }
  for (const poolId in pools.unOfficial) {
    const pool = pools.unOfficial[poolId];
    if (pool.baseMint === mintAddress || pool.quoteMint === mintAddress) {
      pool.id = poolId;
      return pool;
    }
  }
  throw new Error('No Raydium pool found for mint: ' + mintAddress);
}

async function getATA(mint, owner) {
  return await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    new PublicKey(mint),
    owner
  );
}

async function ensureATA(mint, owner) {
  const ata = await getATA(mint, owner);
  const info = await connection.getAccountInfo(ata);
  if (!info) {
    const token = new Token(connection, new PublicKey(mint), TOKEN_PROGRAM_ID, payer);
    const tx = new Transaction().add(
      Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        new PublicKey(mint),
        ata,
        owner,
        payer.publicKey
      )
    );
    await connection.sendTransaction(tx, [payer], { skipPreflight: false, preflightCommitment: 'confirmed' });
  }
  return ata;
}

async function buyToken(mint, solAmount) {
  const pool = await getRaydiumPoolInfo(mint);
  const buyingBase = (pool.baseMint === mint);

  // Raydium pools use WSOL as quote
  const wsolMint = "So11111111111111111111111111111111111111112";
  const fromMint = buyingBase ? wsolMint : mint;
  const toMint = buyingBase ? mint : wsolMint;

  // Wrap SOL if needed
  const userWSOL = await ensureATA(wsolMint, payer.publicKey);
  let amountIn = Math.floor(solAmount * LAMPORTS_PER_SOL);
  let wsolBalance = await connection.getTokenAccountBalance(userWSOL);
  if (Number(wsolBalance.value.amount) < amountIn) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: userWSOL,
        lamports: amountIn
      }),
      Token.createSyncNativeInstruction(TOKEN_PROGRAM_ID, userWSOL)
    );
    await connection.sendTransaction(tx, [payer], { skipPreflight: false, preflightCommitment: 'confirmed' });
  }

  // Ensure ATA for output token
  const userOutATA = await ensureATA(toMint, payer.publicKey);

  // Build swap instruction
  const swapIx = await buildSwapInstruction({
    poolKeys: pool,
    userKeys: {
      tokenAccountIn: userWSOL,
      tokenAccountOut: userOutATA,
      owner: payer.publicKey,
      payer: payer.publicKey,
    },
    amountIn,
    minAmountOut: 1,
    direction: buyingBase ? 'quote2base' : 'base2quote',
  });

  // Send swap
  const tx = new Transaction();
  swapIx.innerTransactions.forEach(({ instructions }) => instructions.forEach(ix => tx.add(ix)));
  const sig = await connection.sendTransaction(tx, [payer], { skipPreflight: false, preflightCommitment: 'confirmed' });
  return sig;
}

async function sellToken(mint, sellPct) {
  const pool = await getRaydiumPoolInfo(mint);
  const baseMint = pool.baseMint;
  const wsolMint = "So11111111111111111111111111111111111111112";

  const userBaseATA = await ensureATA(baseMint, payer.publicKey);
  const userWSOL = await ensureATA(wsolMint, payer.publicKey);

  // Check token balance
  const bal = await connection.getTokenAccountBalance(userBaseATA);
  const amountIn = Math.floor(Number(bal.value.amount) * (sellPct / 100));
  if (amountIn < 1) throw new Error('Not enough token balance to sell');

  // Build swap
  const swapIx = await buildSwapInstruction({
    poolKeys: pool,
    userKeys: {
      tokenAccountIn: userBaseATA,
      tokenAccountOut: userWSOL,
      owner: payer.publicKey,
      payer: payer.publicKey,
    },
    amountIn,
    minAmountOut: 1,
    direction: 'base2quote',
  });

  // Send swap
  const tx = new Transaction();
  swapIx.innerTransactions.forEach(({ instructions }) => instructions.forEach(ix => tx.add(ix)));
  const sig = await connection.sendTransaction(tx, [payer], { skipPreflight: false, preflightCommitment: 'confirmed' });
  return sig;
}

// === TELEGRAM BOT LOGIC ===

function configMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Set/Change Token', 'set_mint')],
    [
      Markup.button.callback('Buy -', 'buy_minus'),
      Markup.button.callback(`${session.buySol} SOL`, 'noop'),
      Markup.button.callback('Buy +', 'buy_plus')
    ],
    [
      Markup.button.callback('Sell % -', 'sell_minus'),
      Markup.button.callback(`${session.sellPct}%`, 'noop'),
      Markup.button.callback('Sell % +', 'sell_plus')
    ],
    [
      Markup.button.callback('Delay -', 'delay_minus'),
      Markup.button.callback(`${session.delaySec}s`, 'noop'),
      Markup.button.callback('Delay +', 'delay_plus')
    ],
    [Markup.button.callback(`Multi-Buy: ${multiBuyMode ? 'ON' : 'OFF'}`, 'multiBuyToggle')],
    [Markup.button.callback('✅ Confirm and Save', 'config_save')],
    [Markup.button.callback('💰 Sell All Tokens', 'sell_all')]
  ]);
}

function sendConfig(ctx, edit = false) {
  const text =
    `🛠️ Pump Bot Configuration:\n` +
    `Token Contract (Mint): ${session.mint ? session.mint : 'Not set'}\n` +
    `Buy Amount: ${session.buySol} SOL\n` +
    `Sell %: ${session.sellPct}%\n` +
    `Delay: ${session.delaySec}s\n` +
    `Multi-Buy: ${multiBuyMode ? 'ON' : 'OFF'}`;

  if (edit) {
    ctx.editMessageText(text, configMenu()).catch(() => {});
  } else {
    ctx.reply(text, configMenu());
  }
}

// --- TELEGRAM HANDLERS ---

bot.start((ctx) => {
  if (ctx.from.id.toString() !== ADMIN) return;
  ctx.reply(
    "Welcome to Net-Buy-Pumpet!\nUse /config to set parameters and /pump to start pumping.",
    configMenu()
  );
});

bot.command('config', (ctx) => {
  if (ctx.from.id.toString() !== ADMIN) return;
  sendConfig(ctx, false);
});

bot.action('set_mint', ctx => {
  if (ctx.from.id.toString() !== ADMIN) return;
  ctx.reply('📝 Please send the token contract address (mint) for the token you want to pump.');
  bot.once('text', async (ctx2) => {
    if (ctx2.from.id.toString() !== ADMIN) return;
    if (!ctx2.message.text || ctx2.message.text.length < 32) return ctx2.reply('❌ Invalid mint address.');
    session.mint = ctx2.message.text.trim();
    ctx2.reply(`✅ Mint address set to:\n${session.mint}`);
    sendConfig(ctx2, false);
  });
  ctx.answerCbQuery();
});

bot.action('buy_minus', ctx => {
  session.buySol = Math.max(0.01, +(session.buySol - 0.01).toFixed(2));
  sendConfig(ctx, true);
  ctx.answerCbQuery();
});
bot.action('buy_plus', ctx => {
  session.buySol = +(session.buySol + 0.01).toFixed(2);
  sendConfig(ctx, true);
  ctx.answerCbQuery();
});
bot.action('sell_minus', ctx => {
  session.sellPct = Math.max(0, session.sellPct - 1);
  sendConfig(ctx, true);
  ctx.answerCbQuery();
});
bot.action('sell_plus', ctx => {
  session.sellPct = Math.min(100, session.sellPct + 1);
  sendConfig(ctx, true);
  ctx.answerCbQuery();
});
bot.action('delay_minus', ctx => {
  session.delaySec = Math.max(1, session.delaySec - 1);
  sendConfig(ctx, true);
  ctx.answerCbQuery();
});
bot.action('delay_plus', ctx => {
  session.delaySec = session.delaySec + 1;
  sendConfig(ctx, true);
  ctx.answerCbQuery();
});
bot.action('multiBuyToggle', ctx => {
  multiBuyMode = !multiBuyMode;
  sendConfig(ctx, true);
  ctx.answerCbQuery();
});
bot.action('config_save', ctx => {
  ctx.reply('✅ Pump configuration updated and saved!');
  ctx.answerCbQuery();
});
bot.action('sell_all', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN) return ctx.answerCbQuery('Not authorized.');
  if (!session.mint) return ctx.answerCbQuery('Set the token contract address first!');
  try {
    let tx = await sellToken(session.mint, 100);
    ctx.reply(`✅ Sold ALL tokens! Tx: https://solscan.io/tx/${tx}`);
    ctx.answerCbQuery('Sold all tokens!');
  } catch (err) {
    ctx.reply(`❌ Sell all failed: ${err.message}`);
    ctx.answerCbQuery('Sell all failed!');
  }
});
bot.action('noop', ctx => ctx.answerCbQuery());

// --- RUN/STOP ---

bot.command('pump', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN) return;
  if (running) return ctx.reply('⏳ Pump already in progress.');
  if (!session.mint) return ctx.reply('❌ Set the token contract address (mint) first! Use /config.');

  running = true;
  ctx.reply(`🔥 Pump started! Running until /stop. Multi-Buy: ${multiBuyMode ? 'ON' : 'OFF'}`);

  let buyAmount = session.buySol;
  let round = 1;

  while (running) {
    try {
      let buysThisRound = multiBuyMode ? session.multiBuys : 1;
      for (let i = 0; i < buysThisRound; i++) {
        try {
          let tx = await buyToken(session.mint, buyAmount);
          ctx.reply(`✅ Buy Tx: https://solscan.io/tx/${tx}`);
        } catch (err) {
          ctx.reply(`❌ Buy failed: ${err.message}`);
        }
      }

      if (session.sellPct > 0) {
        try {
          let tx = await sellToken(session.mint, session.sellPct);
          ctx.reply(`✅ Sell Tx: https://solscan.io/tx/${tx}`);
        } catch (err) {
          ctx.reply(`❌ Sell failed: ${err.message}`);
        }
      }

      buyAmount *= session.buyScale;
      round += 1;

      let delay = Math.max(0.5, session.delaySec * (0.8 + Math.random() * 0.4));
      await new Promise(res => setTimeout(res, delay * 1000));
    } catch (e) {
      ctx.reply(`❌ Round error: ${e.message}`);
    }
  }
  ctx.reply('⏹️ Pump stopped.');
});

bot.command('stop', (ctx) => {
  if (ctx.from.id.toString() !== ADMIN) return;
  running = false;
  ctx.reply('⏹️ Pump will stop after the current round.');
});

// --- MAIN ---
bot.launch().then(() => {
  console.log('Net-Buy-Pumpet bot running!');
  bot.telegram.sendMessage(ADMIN, '🤖 Net-Buy-Pumpet bot deployed and running!');
})
.catch(console.error);

process.on('SIGINT', () => {
  running = false;
  bot.stop('SIGINT');
});
process.on('SIGTERM', () => {
  running = false;
  bot.stop('SIGTERM');
});
