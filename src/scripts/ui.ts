/** Self-contained desk UI served at `/`. Vanilla JS + EventSource (SSE). */
export const INDEX_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Quorum — autonomous prediction desk</title>
<style>
  :root { --bg:#0b0e14; --panel:#11151f; --line:#1e2533; --fg:#d7dce5; --dim:#7b8597;
          --up:#3fb950; --down:#f85149; --neu:#d29922; --acc:#58a6ff; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 var(--mono); }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; letter-spacing:.5px; }
  header .tag { color:var(--dim); font-size:12px; }
  .wrap { display:grid; grid-template-columns: 1fr 360px; gap:0; height:calc(100vh - 56px); }
  .feed { overflow:auto; padding:16px 20px; }
  .side { border-left:1px solid var(--line); padding:16px; overflow:auto; background:var(--panel); }
  .controls { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-left:auto; }
  select,input,button { background:#0d1117; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:6px 10px; font:13px var(--mono); }
  button { background:var(--acc); color:#04101f; border:0; font-weight:700; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .card { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin:8px 0; background:var(--panel); }
  .card .h { font-size:11px; text-transform:uppercase; letter-spacing:.8px; color:var(--dim); margin-bottom:4px; }
  .row { display:flex; justify-content:space-between; gap:10px; }
  .up{color:var(--up)} .down{color:var(--down)} .neu{color:var(--neu)} .acc{color:var(--acc)} .dim{color:var(--dim)}
  .pill { display:inline-block; padding:1px 7px; border-radius:999px; font-size:11px; border:1px solid var(--line); }
  .ctx { font-size:13px; }
  .ctx b { color:#fff; }
  .stat { display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px dashed var(--line); }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { text-align:left; padding:4px 6px; border-bottom:1px solid var(--line); }
  th { color:var(--dim); font-weight:600; }
  .muted{color:var(--dim);font-size:12px}
</style>
</head>
<body>
<header>
  <h1>◢ QUORUM</h1>
  <span class="tag">autonomous prediction desk · DeepBook Predict · testnet (paper)</span>
  <div class="controls">
    <select id="signals">
      <option value="heuristic">heuristic (keyless)</option>
      <option value="manual">manual</option>
      <option value="llm">gemini debate</option>
    </select>
    <input id="prob" type="number" step="0.01" min="0" max="1" value="0.6" title="manual P(up)" style="width:78px" />
    <input id="asset" value="BTC" style="width:64px" title="asset" />
    <button id="run">Run desk ▸</button>
  </div>
</header>
<div class="wrap">
  <div class="feed" id="feed"><p class="muted">Pick a brain and press “Run desk”. Events stream live as the agents reason.</p></div>
  <div class="side">
    <div class="card"><div class="h">Portfolio</div>
      <div class="stat"><span class="dim">Open positions</span><span id="p-open">0</span></div>
      <div class="stat"><span class="dim">Open exposure</span><span id="p-exp">$0.00</span></div>
      <div class="stat"><span class="dim">Realized P&L</span><span id="p-pnl">$0.00</span></div>
    </div>
    <div class="card"><div class="h">Positions</div><table id="p-table"><tbody><tr><td class="muted">none yet</td></tr></tbody></table></div>
  </div>
</div>
<script>
const feed = document.getElementById('feed');
const runBtn = document.getElementById('run');
const fmtPct = x => (x*100).toFixed(1)+'%';
function card(h, body, cls='') { const d=document.createElement('div'); d.className='card '+cls;
  d.innerHTML = '<div class="h">'+h+'</div>'+body; feed.appendChild(d); feed.scrollTop=feed.scrollHeight; return d; }
function leanCls(l){ return l==='up'?'up':l==='down'?'down':'neu'; }

function render(e){
  switch(e.type){
    case 'market_context': { const c=e.context;
      card('Market', '<div class="ctx"><b>'+c.market.asset+'</b> · strike <b>'+c.strike.toLocaleString()+'</b> · expires in '+c.minsToExpiry+'m<br>'+
        'forward '+c.forward.toLocaleString()+' · risk-neutral P(up) <b>'+fmtPct(c.riskNeutralProbUp)+'</b> · market <b>'+fmtPct(c.marketProbUp)+'</b></div>','acc'); break; }
    case 'analyst_signal': { const s=e.signal;
      card(e.analyst+' analyst', '<div class="row"><span class="pill '+leanCls(s.lean)+'">'+s.lean.toUpperCase()+'</span>'+
        '<span class="dim">str '+s.strength.toFixed(2)+' · conf '+s.confidence.toFixed(2)+'</span></div><div class="muted" style="margin-top:6px">'+s.summary+'</div>'); break; }
    case 'debate_turn':
      card(e.speaker+' researcher', '<div>'+e.content+'</div>', e.speaker==='bull'?'':''); break;
    case 'proposal': { const p=e.proposal;
      card('Trader proposal', '<div class="row"><span>subjective P(up) <b class="acc">'+fmtPct(p.subjectiveProbUp)+'</b></span><span class="dim">conf '+p.confidence.toFixed(2)+(p.abstain?' · ABSTAIN':'')+'</span></div>'+
        '<div class="muted" style="margin-top:6px">'+p.reasoning+'</div>'); break; }
    case 'plan': { const p=e.plan;
      card('Plan', '<div class="row"><span class="pill '+leanCls(p.direction)+'">'+p.direction.toUpperCase()+'</span>'+
        '<span>edge <b>'+fmtPct(p.edge)+'</b> · stake '+fmtPct(p.stakeFraction)+' · qty '+p.quantity+'</span></div>','acc'); break; }
    case 'risk_verdict': { const v=e.verdict;
      card('Risk gate', '<div class="row"><span class="pill '+(v.decision==='veto'?'down':v.decision==='resize'?'neu':'up')+'">'+v.decision.toUpperCase()+'</span><span class="dim">'+v.reasoning+'</span></div>'+
        '<div class="muted" style="margin-top:6px">'+v.circuitBreakers.map(b=>'• '+b).join('<br>')+'</div>'); break; }
    case 'execution': { const x=e.envelope;
      card('Execution', '<div class="row"><span class="pill '+(x.status==='filled'?'up':'down')+'">'+x.surface+' / '+x.status+'</span>'+
        '<span>cost ≈ '+x.amountUsd.toFixed(4)+' DUSDC</span></div><div class="muted" style="margin-top:6px">tx '+x.txHash+'</div>','up'); break; }
    case 'portfolio_block': card('Portfolio breaker', '<span class="down">'+e.reason+'</span>','down'); break;
    case 'abstain': card('Abstain', '<span class="neu">@'+e.stage+': '+e.reason+'</span>','neu'); break;
    case 'consensus_published':
      card('Consensus → on-chain', '<div class="row"><span class="pill up">PUBLISHED</span>'+
        '<span>P(up) <b class="acc">'+fmtPct(e.probUpBps/10000)+'</b> · conf '+fmtPct(e.confidenceBps/10000)+' · disagreement '+fmtPct(e.disagreementBps/10000)+'</span></div>'+
        '<div class="muted" style="margin-top:6px">tx <a href="'+e.explorer+'" target="_blank" rel="noopener">'+(e.digest||'').slice(0,18)+'…</a></div>','acc'); break;
    case 'consensus_error': card('Consensus skipped', '<span class="neu">'+e.message+'</span>','neu'); break;
    case 'done': card('Done', '<span class="dim">evidence '+(e.evidenceHash||'').slice(0,24)+'…</span>'); refreshPortfolio(); runBtn.disabled=false; runBtn.textContent='Run desk ▸'; break;
    case 'error': card('Error', '<span class="down">'+e.message+'</span>','down'); runBtn.disabled=false; runBtn.textContent='Run desk ▸'; break;
  }
}

async function refreshPortfolio(){
  try { const p = await (await fetch('/api/portfolio')).json();
    document.getElementById('p-open').textContent=p.open;
    document.getElementById('p-exp').textContent='$'+p.exposureUsd.toFixed(2);
    const pnl=document.getElementById('p-pnl'); pnl.textContent='$'+p.realizedPnlUsd.toFixed(2);
    pnl.className = p.realizedPnlUsd>0?'up':p.realizedPnlUsd<0?'down':'';
    const rows = p.positions.slice(-12).reverse().map(x=>'<tr><td>'+x.asset+'</td><td class="'+(x.direction==='up'?'up':'down')+'">'+x.direction+'</td><td>'+x.strike.toLocaleString()+'</td><td>'+x.status+'</td><td>'+(x.realizedPnlUsd!=null?('$'+x.realizedPnlUsd.toFixed(2)):'—')+'</td></tr>').join('');
    document.querySelector('#p-table tbody').innerHTML = rows || '<tr><td class="muted">none yet</td></tr>';
  } catch {}
}

runBtn.onclick = () => {
  feed.innerHTML=''; runBtn.disabled=true; runBtn.textContent='Running…';
  const q = new URLSearchParams({ signals:document.getElementById('signals').value,
    prob:document.getElementById('prob').value, asset:document.getElementById('asset').value });
  const es = new EventSource('/api/run?'+q.toString());
  es.onmessage = (m) => { const e=JSON.parse(m.data); render(e); if(e.type==='done'||e.type==='error') es.close(); };
  es.onerror = () => { es.close(); runBtn.disabled=false; runBtn.textContent='Run desk ▸'; };
};
refreshPortfolio();
</script>
</body>
</html>`;
