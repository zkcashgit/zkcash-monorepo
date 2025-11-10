require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
const { Connection } = require('@solana/web3.js');
const { FALLBACK } = require('./utils/tokens');
const { nanoid } = require('nanoid');

const app = express();
const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 50);

const allowList = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({
  origin(origin, cb){
    if(!origin || allowList.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin));
  }
}));
app.use(express.json({ limit: '512kb' }));
app.use(compression());
app.use(morgan('tiny'));
app.use(rateLimit({
  windowMs: 10_000,
  limit: 160,
  standardHeaders: true,
  legacyHeaders: false
}));

// Simple id for tracing
app.use((req,res,next)=>{ req.reqId = nanoid(8); next(); });

// Health
app.get('/api/health', (_req, res) => {
  res.json({ ok:true, service:'zkcash-backend', time:new Date().toISOString() });
});

// Proxy: token list (Jupiter)
app.get('/api/tokens', async (_req, res) => {
  try{
    const r = await fetch('https://token.jup.ag/all', { cache: 'no-store' });
    if(!r.ok) throw new Error('token list fetch failed');
    const all = await r.json();
    // Keep verified + common ones at top
    const curated = all.filter(t => ['SOL','USDC','USDT','mSOL','JitoSOL','bSOL','WIF','BONK'].includes(t.symbol) || t.tags?.includes('verified'));
    res.json({ ok:true, tokens: curated });
  }catch(e){
    res.json({ ok:true, tokens: FALLBACK, fallback:true });
  }
});

// Proxy: quote (Jupiter v6)
app.get('/api/quote', async (req, res) => {
  const { inputMint, outputMint, amount, slippageBps } = req.query;
  if(!inputMint || !outputMint || !amount) return res.status(400).json({ error:'Missing params' });
  const sp = new URLSearchParams({
    inputMint, outputMint,
    amount, slippageBps: String(slippageBps || SLIPPAGE_BPS),
    swapMode: 'ExactIn',
    onlyDirectRoutes: 'false'
  });
  const url = `https://quote-api.jup.ag/v6/quote?${sp.toString()}`;
  try{
    const r = await fetch(url, { cache:'no-store' });
    const j = await r.json();
    if(r.ok) return res.json(j);
    res.status(400).json(j);
  }catch(e){
    res.status(500).json({ error:'Quote proxy failed', details: String(e) });
  }
});

// Proxy: build swap transaction (Jupiter v6)
app.post('/api/swap', async (req, res) => {
  const { quoteResponse, userPublicKey, wrapAndUnwrapSol = true, destinationWallet } = req.body || {};
  if(!quoteResponse || !userPublicKey){
    return res.status(400).json({ error:'Missing quoteResponse or userPublicKey' });
  }
  try{
    const r = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol,
        destinationWallet,
        // you can tweak compute budget if needed:
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto'
      })
    });
    const j = await r.json();
    if(r.ok) return res.json(j);
    res.status(400).json(j);
  }catch(e){
    res.status(500).json({ error:'Swap proxy failed', details: String(e) });
  }
});

// Tx status (RPC)
const connection = new Connection(RPC_URL, 'confirmed');
app.get('/api/tx/:sig', async (req, res) => {
  try{
    const sig = req.params.sig;
    const st = await connection.getSignatureStatuses([sig], { searchTransactionHistory:true });
    res.json({ ok:true, value: st.value?.[0] || null });
  }catch(e){
    res.status(500).json({ error:'RPC status failed', details:String(e) });
  }
});

// 404
app.use((_req,res)=> res.status(404).json({ error:'Route not found' }));

app.listen(PORT, ()=> console.log(`ZKCash backend listening on :${PORT}`));
