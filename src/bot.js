import { Bot, InlineKeyboard } from 'grammy';
import 'dotenv/config';
import { startNetBuyPump } from './engine.js';

const bot = new Bot(process.env.TG_BOT_TOKEN!);
const ADMIN = Number(process.env.ADMIN_ID);
const sessions: Record<number, any> = {};
let running = false;

bot.command('start', async (ctx) => {
  const kb = new InlineKeyboard()
    .text('⚙️ Configure', 'cfg')
    .text('🚀 Start Pump', 'start')
    .text('⏹ Stop', 'stop')
    .text('📊 Status', 'status');
  await ctx.reply('Net-Buy Pumper Bot', { reply_markup: kb });
});

bot.callbackQuery('cfg', async (ctx) => {
  if (ctx.from?.id !== ADMIN) return ctx.answerCallbackQuery('❌ Admin only');
  await ctx.editMessageText(
    'Send config line:\n`<mint> <buySolPerRound> <sellRatioPct> <rounds> <delaySec>`\nExample: `DEADMINT 0.05 90 30 2`',
    { parse_mode: 'Markdown' }
  );
  sessions[ctx.from!.id] = {};
});

bot.on('message:text', (ctx) => {
  if (ctx.from?.id !== ADMIN) return;
  const d = ctx.message.text.split(' ');
  if (d.length !== 5) return ctx.reply('Bad format, try again');
  sessions[ctx.from!.id] = {
    mint: d[0],
    buySolPerRound: Number(d[1]),
    sellRatioPct: Number(d[2]),
    rounds: Number(d[3]),
    delaySec: Number(d[4]),
  };
  ctx.reply('✅ Config saved. Press 🚀');
});

bot.callbackQuery('start', async (ctx) => {
  if (ctx.from?.id !== ADMIN || running) return ctx.answerCallbackQuery('❌');
  const c = sessions[ctx.from!.id];
  if (!c.mint) return ctx.answerCallbackQuery('Configure first');
  running = true;
  await ctx.editMessageText('🚀 Net-buy pump started…');
  startNetBuyPump({
    ...c,
    onProgress: (r, spent) =>
      bot.api.sendMessage(ADMIN, `📈 Round ${r} | net spent ${spent.toFixed(3)} SOL`),
    onFinish: (spent) => {
      bot.api.sendMessage(ADMIN, `✅ Done. Net spent ${spent.toFixed(3)} SOL`);
      running = false;
    },
  });
});

bot.callbackQuery('stop', async (ctx) => {
  if (ctx.from?.id !== ADMIN) return ctx.answerCallbackQuery('❌');
  running = false;
  await ctx.editMessageText('⏹ Stopped.');
});

bot.callbackQuery('status', (ctx) =>
  ctx.answerCallbackQuery(running ? '⏳ Running' : 'Idle')
);

bot.start();
