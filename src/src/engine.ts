import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import {
  Liquidity,
  jsonInfo2PoolKeys,
  TokenAmount,
  Token as RToken,
} from '@raydium-io/raydium-sdk';
import bs58 from 'bs58';
import 'dotenv/config';

const conn = new Connection(process.env.RPC!);
const payer = process.env.PRIVATE_KEY!.startsWith('[')
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY!)))
  : Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));

interface Opts {
  mint: string;
  buySolPerRound: number;
  sellRatioPct: number;
  rounds: number;
  delaySec: number;
  onProgress: (round: number, spent: number) => void;
  onFinish: (spent: number) => void;
}

export function startNetBuyPump(opts: Opts) {
  let aborted = false;
  let totalNetSpent = 0;

  (async () => {
    const mint = new PublicKey(opts.mint);
    const poolRaw = (
      await (
        await fetch(`https://api.raydium.io/v2/sdk/liquidity/mainnet.json?mint=${mint}`)
      ).json()
    ).official.find(
      (p: any) => p.baseMint === mint.toString() || p.quoteMint === mint.toString()
    );
    if (!poolRaw) throw new Error('Pool not found');
    const poolKeys = jsonInfo2PoolKeys(poolRaw);

    const base = new RToken(poolKeys.baseMint, 6, 'TOKEN', 'TOKEN');
    const quote = new RToken(poolKeys.quoteMint, 9, 'SOL', 'SOL');
    const buyAmount = new TokenAmount(quote, opts.buySolPerRound * 1e9);

    for (let i = 1; i <= opts.rounds && !aborted; i++) {
      // BUY
      const { innerTransactions: buy } = await Liquidity.makeSwapInstructionSimple({
        connection: conn,
        poolKeys,
        userKeys: { owner: payer.publicKey, tokenAccounts: [] },
        amountIn: buyAmount,
        amountOutMin: new TokenAmount(base, 0),
        fixedSide: 'in',
        makeTxVersion: 0,
      });
      const txBuy = new Transaction().add(...buy.flatMap((t) => t.instructions));
      txBuy.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      txBuy.sign(payer);
      await conn.sendRawTransaction(txBuy.serialize());

      // SELL (only sellRatioPct % of what we bought)
      const sellAmount = new TokenAmount(
        base,
        buyAmount.muln(opts.sellRatioPct).divn(100).raw
      );
      const { innerTransactions: sell } = await Liquidity.makeSwapInstructionSimple({
        connection: conn,
        poolKeys,
        userKeys: { owner: payer.publicKey, tokenAccounts: [] },
        amountIn: sellAmount,
        amountOutMin: new TokenAmount(quote, 0),
        fixedSide: 'in',
        makeTxVersion: 0,
      });
      const txSell = new Transaction().add(...sell.flatMap((t) => t.instructions));
      txSell.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      txSell.sign(payer);
      await conn.sendRawTransaction(txSell.serialize());

      totalNetSpent += opts.buySolPerRound * (1 - opts.sellRatioPct / 100);
      opts.onProgress(i, totalNetSpent);
      await new Promise((r) => setTimeout(r, opts.delaySec * 1000));
    }
    if (!aborted) opts.onFinish(totalNetSpent);
  })();

  return { abort: () => (aborted = true) };
}
