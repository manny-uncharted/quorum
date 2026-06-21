"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { 
  Play, Loader2, Coins, Layers, ShieldCheck, Database, 
  TrendingUp, TrendingDown, ExternalLink, HelpCircle, 
  ArrowLeft, RefreshCw, AlertCircle, CheckCircle2, Cpu 
} from "lucide-react";
import styles from "../../styles/styles.module.css";

interface Position {
  asset: string;
  direction: string;
  strike: number;
  status: string;
  realizedPnlUsd?: number;
}

interface PortfolioData {
  open: number;
  exposureUsd: number;
  realizedPnlUsd: number;
  positions: Position[];
}

export default function DashboardPage() {
  const [signals, setSignals] = useState("heuristic");
  const [prob, setProb] = useState("0.60");
  const [asset, setAsset] = useState("BTC");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<any[]>([]);
  const [markets, setMarkets] = useState<any[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<any>(null);
  const [portfolio, setPortfolio] = useState<PortfolioData>({
    open: 0,
    exposureUsd: 0.0,
    realizedPnlUsd: 0.0,
    positions: [],
  });

  const feedRef = useRef<HTMLDivElement>(null);

  // Fetch portfolio and active markets on mount
  useEffect(() => {
    fetchPortfolio();
    fetchMarkets();
  }, []);

  // Auto scroll the reasoning feed to the bottom as new events stream in
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events]);

  const fetchMarkets = async () => {
    try {
      const res = await fetch("/api/markets");
      if (res.ok) {
        const data = await res.json();
        setMarkets(data);
        if (data.length > 0) {
          setSelectedMarket(data[0]);
          setAsset(data[0].asset);
        }
      }
    } catch (e) {
      console.error("Failed to load options markets", e);
    }
  };

  const fetchPortfolio = async () => {
    try {
      const res = await fetch("/api/portfolio");
      if (res.ok) {
        const data = await res.json();
        setPortfolio(data);
      }
    } catch (e) {
      console.error("Failed to load portfolio stats", e);
    }
  };

  const handleRun = () => {
    setEvents([]);
    setRunning(true);
    
    const params = new URLSearchParams({
      signals,
      prob,
      asset,
    });
    if (selectedMarket) {
      params.append("market", selectedMarket.oracleId);
    }

    const eventSource = new EventSource(`/api/run?${params.toString()}`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setEvents((prev) => [...prev, data]);
        
        if (data.type === "done" || data.type === "error") {
          eventSource.close();
          setRunning(false);
          fetchPortfolio();
        }
      } catch (e) {
        console.error("Error parsing event data", e);
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      setRunning(false);
      setEvents((prev) => [
        ...prev,
        { type: "error", message: "SSE stream connection disrupted." },
      ]);
    };
  };

  const formatPct = (val: number) => `${(val * 100).toFixed(1)}%`;
  
  const getLeanClass = (lean: string) => {
    if (lean === "up") return styles.colorUp;
    if (lean === "down") return styles.colorDown;
    return styles.colorNeutral;
  };

  const renderEventCard = (e: any, index: number) => {
    switch (e.type) {
      case "market_context": {
        const c = e.context;
        return (
          <div key={index} className={`${styles.eventCard} ${styles.bgAccent} glass-panel`}>
            <div className={styles.eventHeader}>
              <TrendingUp size={12} className={styles.colorAccent} />
              Market context compiled
            </div>
            <div className={styles.eventTitle}>
              {c.market.asset} Option (strike ${c.strike.toLocaleString()})
            </div>
            <div className={styles.eventRow} style={{ marginTop: "12px" }}>
              <div className={styles.eventMeta}>
                Forward: <b>${c.forward.toLocaleString()}</b> · Exp: {c.minsToExpiry}m
              </div>
            </div>
            <div className={styles.statsBlock} style={{ marginTop: "14px" }}>
              <div className={styles.statCell}>
                <div className={styles.sliderLabel}>Implied Market P(up)</div>
                <div className={styles.statVal}>{formatPct(c.marketProbUp)}</div>
              </div>
              <div className={styles.statCell}>
                <div className={styles.sliderLabel}>Fair Baseline P(up)</div>
                <div className={styles.statVal}>{formatPct(c.riskNeutralProbUp)}</div>
              </div>
            </div>
          </div>
        );
      }
      
      case "analyst_signal": {
        const s = e.signal;
        return (
          <div key={index} className={`${styles.eventCard} glass-panel`}>
            <div className={styles.eventHeader}>
              <Cpu size={12} />
              Analyst signal · {e.analyst}
            </div>
            <div style={{ display: "flex", justifyItems: "center", justifyContent: "space-between", alignItems: "center" }}>
              <span className={`${styles.pill} ${s.lean === "up" ? styles.bgUp : s.lean === "down" ? styles.bgDown : styles.bgNeutral} ${getLeanClass(s.lean)}`} style={{ textTransform: "uppercase" }}>
                {s.lean}
              </span>
              <span className={styles.eventMeta}>
                Strength: {s.strength.toFixed(2)} · Confidence: {s.confidence.toFixed(2)}
              </span>
            </div>
            <p className={styles.eventReasoning}>{s.summary}</p>
          </div>
        );
      }

      case "debate_turn": {
        const isBull = e.speaker === "bull";
        return (
          <div key={index} className={`${styles.eventCard} glass-panel`} style={{ borderLeft: `3px solid ${isBull ? "var(--color-up)" : "var(--color-down)"}` }}>
            <div className={styles.eventHeader}>
              <Layers size={12} className={isBull ? styles.colorUp : styles.colorDown} />
              Debate turn · {e.speaker} researcher
            </div>
            <p className={styles.eventReasoning} style={{ fontStyle: "italic" }}>"{e.content}"</p>
          </div>
        );
      }

      case "proposal": {
        const p = e.proposal;
        return (
          <div key={index} className={`${styles.eventCard} ${p.abstain ? styles.bgNeutral : styles.bgAccent} glass-panel`}>
            <div className={styles.eventHeader}>
              <Coins size={12} />
              Trader proposal
            </div>
            <div className={styles.eventRow}>
              <div className={styles.eventTitle}>
                Subjective P(up): <span className={styles.colorAccent}>{formatPct(p.subjectiveProbUp)}</span>
              </div>
              <span className={styles.eventMeta}>
                Confidence: {p.confidence.toFixed(2)} {p.abstain && "· ABSTAIN"}
              </span>
            </div>
            <p className={styles.eventReasoning}>{p.reasoning}</p>
            {p.keyDrivers && p.keyDrivers.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "12px" }}>
                {p.keyDrivers.map((d: string, i: number) => (
                  <span key={i} className={styles.pill} style={{ fontSize: "10px" }}>{d}</span>
                ))}
              </div>
            )}
          </div>
        );
      }

      case "plan": {
        const p = e.plan;
        return (
          <div key={index} className={`${styles.eventCard} ${styles.bgAccent} glass-panel`}>
            <div className={styles.eventHeader}>
              <Layers size={12} className={styles.colorAccent} />
              Quant trade plan sized
            </div>
            <div className={styles.eventRow}>
              <span className={`${styles.pill} ${p.direction === "up" ? styles.bgUp : styles.bgDown} ${getLeanClass(p.direction)}`} style={{ textTransform: "uppercase" }}>
                MINT {p.direction}
              </span>
              <div className={styles.statVal} style={{ fontSize: "16px", margin: 0 }}>
                Edge: <span className={styles.colorUp}>+{formatPct(p.edge)}</span>
              </div>
            </div>
            <div className={styles.statsBlock} style={{ marginTop: "12px" }}>
              <div className={styles.statCell}>
                <div className={styles.sliderLabel}>Kelly Stake Fraction</div>
                <div className={styles.statVal} style={{ fontSize: "15px" }}>{formatPct(p.stakeFraction)}</div>
              </div>
              <div className={styles.statCell}>
                <div className={styles.sliderLabel}>Contracts Qty</div>
                <div className={styles.statVal} style={{ fontSize: "15px" }}>{p.quantity.toString()}</div>
              </div>
            </div>
          </div>
        );
      }

      case "risk_verdict": {
        const v = e.verdict;
        const isApprove = v.decision === "approve";
        const isVeto = v.decision === "veto";
        return (
          <div key={index} className={`${styles.eventCard} ${isApprove ? styles.bgUp : isVeto ? styles.bgDown : styles.bgNeutral} glass-panel`}>
            <div className={styles.eventHeader}>
              <ShieldCheck size={12} className={isApprove ? styles.colorUp : isVeto ? styles.colorDown : styles.colorNeutral} />
              Risk officer verdict
            </div>
            <div className={styles.eventRow}>
              <span className={styles.eventTitle} style={{ color: isApprove ? "var(--color-up)" : isVeto ? "var(--color-down)" : "var(--color-neutral)" }}>
                {v.decision.toUpperCase()}
              </span>
            </div>
            <p className={styles.eventReasoning}>{v.reasoning}</p>
            {v.circuitBreakers && v.circuitBreakers.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "10px" }}>
                {v.circuitBreakers.map((b: string, i: number) => (
                  <span key={i} className={styles.eventMeta} style={{ fontSize: "11px" }}>• {b}</span>
                ))}
              </div>
            )}
          </div>
        );
      }

      case "execution": {
        const x = e.envelope;
        const isFilled = x.status === "filled";
        return (
          <div key={index} className={`${styles.eventCard} ${isFilled ? styles.bgUp : styles.bgDown} glass-panel`}>
            <div className={styles.eventHeader}>
              <Coins size={12} className={isFilled ? styles.colorUp : styles.colorDown} />
              Execution provider result
            </div>
            <div className={styles.eventRow}>
              <span className={styles.eventTitle}>{x.surface} option / {x.status.toUpperCase()}</span>
              <span className={styles.eventMeta}>Cost: {x.amountUsd.toFixed(4)} DUSDC</span>
            </div>
            <div className={styles.eventReasoning} style={{ fontSize: "11px", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
              Tx: {x.txHash}
            </div>
          </div>
        );
      }

      case "consensus_published": {
        return (
          <div key={index} className={`${styles.eventCard} ${styles.bgAccent} glass-panel`} style={{ borderColor: "var(--color-accent)" }}>
            <div className={styles.eventHeader}>
              <Database size={12} className={styles.colorAccent} />
              Consensus Oracle Published
            </div>
            <div className={styles.statsBlock}>
              <div className={styles.statCell}>
                <div className={styles.sliderLabel}>Consensus P(up)</div>
                <div className={styles.statVal} style={{ fontSize: "16px" }}>{formatPct(e.probUpBps / 10000)}</div>
              </div>
              <div className={styles.statCell}>
                <div className={styles.sliderLabel}>Disagreement Index</div>
                <div className={styles.statVal} style={{ fontSize: "16px", color: "var(--color-neutral)" }}>{formatPct(e.disagreementBps / 10000)}</div>
              </div>
            </div>
            <div className={styles.eventRow} style={{ marginTop: "12px" }}>
              <a href={e.explorer} target="_blank" rel="noopener noreferrer" className={styles.btn} style={{ fontSize: "11px", padding: "6px 12px" }}>
                Sui Explorer <ExternalLink size={10} />
              </a>
            </div>
          </div>
        );
      }

      case "portfolio_block":
        return (
          <div key={index} className={`${styles.eventCard} ${styles.bgDown} glass-panel`}>
            <div className={styles.eventHeader} style={{ color: "var(--color-down)" }}>
              <AlertCircle size={12} />
              Portfolio breaker tripped
            </div>
            <p className={styles.eventReasoning} style={{ color: "var(--color-down)" }}>{e.reason}</p>
          </div>
        );

      case "abstain":
        return (
          <div key={index} className={`${styles.eventCard} ${styles.bgNeutral} glass-panel`}>
            <div className={styles.eventHeader} style={{ color: "var(--color-neutral)" }}>
              <HelpCircle size={12} />
              Desk execution abstained
            </div>
            <div className={styles.eventTitle} style={{ color: "var(--color-neutral)", fontSize: "14px" }}>
              Stage: {e.stage}
            </div>
            <p className={styles.eventReasoning}>{e.reason}</p>
          </div>
        );

      case "done":
        return (
          <div key={index} className={`${styles.eventCard} ${styles.bgUp} glass-panel`} style={{ borderColor: "var(--color-up)" }}>
            <div className={styles.eventHeader} style={{ color: "var(--color-up)" }}>
              <CheckCircle2 size={12} />
              Run completed
            </div>
            <div className={styles.eventMeta} style={{ fontFamily: "var(--font-mono)" }}>
              Evidence bundle hash: <b>{e.evidenceHash.slice(0, 32)}...</b>
            </div>
          </div>
        );

      case "error":
        return (
          <div key={index} className={`${styles.eventCard} ${styles.bgDown} glass-panel`}>
            <div className={styles.eventHeader} style={{ color: "var(--color-down)" }}>
              <AlertCircle size={12} />
              Runtime Error
            </div>
            <p className={styles.eventReasoning} style={{ color: "var(--color-down)", fontWeight: "bold" }}>{e.message}</p>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Header Bar */}
      <header className={styles.header}>
        <div className={styles.headerContainer} style={{ maxWidth: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <Link href="/" className={styles.navLink}>
              <ArrowLeft size={16} style={{ marginRight: "4px", verticalAlign: "middle" }} /> Back
            </Link>
            <span className={styles.logo} style={{ fontSize: "16px" }}>◢ QUORUM DESK</span>
          </div>
          <div className={styles.eventMeta} style={{ fontSize: "12px" }}>
            Network: <span className={styles.colorUp}>Sui Testnet</span> · Mode: <span className={styles.colorAccent}>Paper</span>
          </div>
        </div>
      </header>

      {/* Control Strip Sub-header */}
      <div className={styles.controlStrip}>
        <div className={styles.controlStripContainer}>
          <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <span className={styles.sliderLabel} style={{ fontSize: "10px" }}>Brain Model</span>
              <select 
                value={signals} 
                onChange={(e) => setSignals(e.target.value)} 
                className={styles.inputControl}
                disabled={running}
              >
                <option value="heuristic">Heuristic Brain (Keyless)</option>
                <option value="manual">Manual Brain</option>
                <option value="llm">Gemini Debate Brain</option>
              </select>
            </div>

            {signals === "manual" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <span className={styles.sliderLabel} style={{ fontSize: "10px" }}>Manual P(up)</span>
                <input 
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={prob}
                  onChange={(e) => setProb(e.target.value)}
                  className={styles.inputControl}
                  style={{ width: "80px" }}
                  disabled={running}
                />
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <span className={styles.sliderLabel} style={{ fontSize: "10px" }}>Asset Override</span>
              <input 
                value={asset}
                onChange={(e) => setAsset(e.target.value.toUpperCase())}
                className={styles.inputControl}
                style={{ width: "70px" }}
                disabled={running}
              />
            </div>

            {selectedMarket && (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <span className={styles.sliderLabel} style={{ fontSize: "10px" }}>Target Market</span>
                <div className={styles.inputControl} style={{ background: "rgba(88, 166, 255, 0.05)", border: "1px dashed rgba(88, 166, 255, 0.2)", minWidth: "120px" }}>
                  {selectedMarket.asset} Option · {selectedMarket.minsToExpiry}m left
                </div>
              </div>
            )}
          </div>

          <button 
            onClick={handleRun} 
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={running || !selectedMarket}
            style={{ padding: "10px 24px" }}
          >
            {running ? (
              <>
                <Loader2 size={14} className="spin" style={{ animation: "spin 1s linear infinite" }} /> Reasoning...
              </>
            ) : (
              <>
                <Play size={14} /> Run consensus desk ▸
              </>
            )}
          </button>
        </div>
      </div>

      {/* Main content grid */}
      <div className={styles.dashWrapper}>
        {/* Column 1: Options Markets List */}
        <div className={`${styles.sidebarCard} glass-panel`} style={{ padding: "16px", display: "flex", flexDirection: "column" }}>
          <div className={styles.cardHeader} style={{ marginBottom: "12px" }}>Active Options</div>
          <div className={styles.marketList}>
            {markets.length === 0 ? (
              <div style={{ color: "var(--fg-dim)", fontSize: "12px", fontStyle: "italic", textAlign: "center", padding: "20px" }}>
                No active markets.
              </div>
            ) : (
              markets.map((m, idx) => {
                const isActive = selectedMarket?.oracleId === m.oracleId;
                return (
                  <div 
                    key={idx}
                    className={`${styles.marketCard} ${isActive ? styles.marketCardActive : ""}`}
                    onClick={() => !running && setSelectedMarket(m)}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold" }}>
                      <span>{m.asset} option</span>
                      <span className={styles.colorAccent} style={{ fontSize: "11px", fontFamily: "var(--font-mono)" }}>
                        {m.minsToExpiry}m left
                      </span>
                    </div>
                    <div className={styles.eventMeta} style={{ fontSize: "11px", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                      ID: {m.oracleId.slice(0, 10)}...
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Column 2: Feed Column */}
        <div className={styles.dashFeed} ref={feedRef}>
          {events.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--fg-dim)" }}>
              <Database size={48} style={{ opacity: 0.15, marginBottom: "16px" }} />
              <p style={{ fontSize: "14px", fontFamily: "var(--font-mono)", textAlign: "center", padding: "0 20px" }}>
                Select an option contract on the left, set model parameters in the control strip, and trigger "Run consensus desk" to watch the agents reason live.
              </p>
            </div>
          ) : (
            events.map((e, idx) => renderEventCard(e, idx))
          )}
        </div>

        {/* Column 3: Sidebar Column */}
        <div className={styles.dashSidebar}>
          {/* Portfolio Stats */}
          <div className={`${styles.sidebarCard} glass-panel`}>
            <div className={styles.cardHeader}>Portfolio Balances</div>
            <div className={styles.statRow}>
              <span className={styles.statLabel}>Open positions</span>
              <span className={styles.statValue}>{portfolio.open}</span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statLabel}>Total exposure</span>
              <span className={styles.statValue}>${portfolio.exposureUsd.toFixed(2)}</span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statLabel}>Realized P&L</span>
              <span className={`${styles.statValue} ${portfolio.realizedPnlUsd > 0 ? styles.colorUp : portfolio.realizedPnlUsd < 0 ? styles.colorDown : ""}`}>
                ${portfolio.realizedPnlUsd.toFixed(2)}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "14px" }}>
              <button onClick={fetchPortfolio} className={styles.btn} style={{ padding: "6px 12px", fontSize: "11px" }}>
                <RefreshCw size={10} style={{ marginRight: "4px" }} /> Refresh
              </button>
            </div>
          </div>

          {/* Active Positions */}
          <div className={`${styles.sidebarCard} glass-panel`} style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <div className={styles.cardHeader}>Recent Closed & Active bets</div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {portfolio.positions.length === 0 ? (
                <div style={{ color: "var(--fg-dim)", fontSize: "12px", fontStyle: "italic", textAlign: "center", padding: "20px" }}>
                  No historical trade actions.
                </div>
              ) : (
                <table className={styles.positionsTable}>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Lean</th>
                      <th>Strike</th>
                      <th>Status</th>
                      <th>P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {portfolio.positions.slice(-15).reverse().map((pos, idx) => (
                      <tr key={idx}>
                        <td>{pos.asset}</td>
                        <td className={pos.direction === "up" ? styles.colorUp : styles.colorDown}>
                          {pos.direction.toUpperCase()}
                        </td>
                        <td>${pos.strike.toLocaleString()}</td>
                        <td style={{ fontSize: "10px", color: pos.status === "filled" ? "var(--color-up)" : "var(--fg-dim)" }}>
                          {pos.status.toUpperCase()}
                        </td>
                        <td className={pos.realizedPnlUsd && pos.realizedPnlUsd > 0 ? styles.colorUp : pos.realizedPnlUsd && pos.realizedPnlUsd < 0 ? styles.colorDown : ""}>
                          {pos.realizedPnlUsd != null ? `$${pos.realizedPnlUsd.toFixed(2)}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
