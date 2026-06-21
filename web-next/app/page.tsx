"use client";

import React, { useState } from "react";
import Link from "next/link";
import { ArrowRight, Cpu, ShieldAlert, BarChart3, Database, Coins, Share2, Layers } from "lucide-react";
import styles from "../styles/styles.module.css";

export default function LandingPage() {
  const [edge, setEdge] = useState(7.0); // subjective edge in percentage
  const [confidence, setConfidence] = useState(71); // confidence index in percentage
  const [disagreement, setDisagreement] = useState(18); // analyst disagreement index in percentage
  
  // Calculate downstream vault skew allocation based on live stats
  // formula: edge * confidence * (1 - disagreement)
  const trustFactor = (100 - disagreement) / 100;
  const rawAllocation = edge * (confidence / 100) * trustFactor;
  const vaultAllocation = Math.min(20, parseFloat(rawAllocation.toFixed(1)));

  return (
    <div style={{ position: "relative", minHeight: "100vh" }}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerContainer}>
          <Link href="/" className={styles.logo}>
            <span className={styles.logoIcon}>◢</span> QUORUM
          </Link>
          <nav className={styles.nav}>
            <a href="#features" className={styles.navLink}>Mechanics</a>
            <a href="#composability" className={styles.navLink}>Composability</a>
            <a href="#pipeline" className={styles.navLink}>Pipeline</a>
            <Link href="/dashboard" className={`${styles.btn} ${styles.btnPrimary}`}>
              Launch Desk Console <ArrowRight size={14} />
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero Section */}
      <section className={styles.hero}>
        <div className={styles.heroContent}>
          <div className={styles.eyebrow}>DeepBook Predict Track</div>
          <h1 className={styles.heroTitle}>
            Autonomous agents that <span className={styles.gradText}>debate, trade, and publish</span> consensus on-chain.
          </h1>
          <p className={styles.heroDesc}>
            Quorum is a multi-agent prediction-market trading desk built on Sui's DeepBook Predict. It operates as the first forward-looking, reasoning-derived probability oracle on Sui.
          </p>
          <div className={styles.ctaGroup}>
            <Link href="/dashboard" className={`${styles.btn} ${styles.btnPrimary}`}>
              Launch Live Console <ArrowRight size={14} />
            </Link>
            <a href="#features" className={styles.btn}>
              Explore Mechanics
            </a>
          </div>
          <div className={styles.heroPills}>
            <span className={styles.pill}>
              <span className={styles.pillAccent}>4</span> Analysts → Consensus Debate
            </span>
            <span className={styles.pill}>Code-Owned Kelly + Risk Gate</span>
            <span className={styles.pill}>Signed Evidence Bundles</span>
            <span className={styles.pill}>On-Chain Consensus Feed</span>
          </div>
        </div>

        {/* Orbit SVG Visualizer */}
        <div style={{ position: "relative" }}>
          <svg className={styles.orbitGraphic} viewBox="0 0 512 512">
            <circle className={styles.orbitRing} cx="256" cy="256" r="160" />
            <circle className={styles.orbitRing} cx="256" cy="256" r="80" />
            
            <g className={styles.orbitRotate}>
              {/* Spoke lines */}
              <line className={styles.orbitSpoke} x1="256" y1="256" x2="256" y2="96" />
              <line className={styles.orbitSpoke} x1="256" y1="256" x2="394" y2="176" />
              <line className={styles.orbitSpoke} x1="256" y1="256" x2="394" y2="336" />
              <line className={styles.orbitSpoke} x1="256" y1="256" x2="256" y2="416" />
              <line className={styles.orbitSpoke} x1="256" y1="256" x2="118" y2="336" />
              <line className={styles.orbitSpoke} x1="256" y1="256" x2="118" y2="176" />
              
              {/* Analyst Nodes */}
              <circle className={`${styles.orbitNode} pulse-glow`} cx="256" cy="96" r="16" style={{ stroke: "#58a6ff" }} />
              <circle className={`${styles.orbitNode} pulse-glow`} cx="394" cy="176" r="16" style={{ stroke: "#3fb950", animationDelay: "0.5s" }} />
              <circle className={`${styles.orbitNode} pulse-glow`} cx="394" cy="336" r="16" style={{ stroke: "#f85149", animationDelay: "1.0s" }} />
              <circle className={`${styles.orbitNode} pulse-glow`} cx="256" cy="416" r="16" style={{ stroke: "#d29922", animationDelay: "1.5s" }} />
              <circle className={`${styles.orbitNode} pulse-glow`} cx="118" cy="336" r="16" style={{ stroke: "#58a6ff", animationDelay: "2.0s" }} />
              <circle className={`${styles.orbitNode} pulse-glow`} cx="118" cy="176" r="16" style={{ stroke: "#3fb950", animationDelay: "2.5s" }} />
            </g>
            
            {/* Core Trader Node */}
            <circle className={styles.orbitCore} cx="256" cy="256" r="32" />
            <path d="M250 248l12 8-12 8v-16z" fill="#04060a" transform="translate(3, 0)" />
          </svg>
        </div>
      </section>

      {/* Mechanics Bento Grid */}
      <section id="features" className={`${styles.section} wrap`} style={{ maxWidth: "1200px", margin: "0 auto" }}>
        <div className={styles.sectionHeader}>
          <div className={styles.eyebrow}>Architecture</div>
          <h2 className={styles.sectionTitle}>The prediction desk, rebuilt from first principles.</h2>
          <p className={styles.sectionDesc}>
            A binary option's price is its risk-neutral probability. Edge exists only where real-world probability differs from the baseline. Quorum models that difference using structured systems.
          </p>
        </div>
        
        <div className={styles.bento}>
          <div className={`${styles.bentoCard} glass-panel`}>
            <Cpu className={styles.bentoIcon} />
            <h3 className={styles.bentoCardTitle}>Debate & Calibration Core</h3>
            <p className={styles.bentoCardDesc}>
              Four specialized LLM analysts (volatility, momentum, catalyst, order flow) feed into a structured debate before yielding a unified subjective probability.
            </p>
          </div>
          
          <div className={`${styles.bentoCard} glass-panel`}>
            <BarChart3 className={styles.bentoIcon} />
            <h3 className={styles.bentoCardTitle}>Deterministic Kelly Sizing</h3>
            <p className={styles.bentoCardDesc}>
              A code-owned quant core handles the arithmetic. Option pricing surfaces evaluate edge, sizing bets using fractional Kelly rules. No models compute sizes.
            </p>
          </div>
          
          <div className={`${styles.bentoCard} glass-panel`}>
            <ShieldAlert className={styles.bentoIcon} />
            <h3 className={styles.bentoCardTitle}>Code-Owned Risk Gates</h3>
            <p className={styles.bentoCardDesc}>
              Exposure thresholds, daily-loss limits, time-to-expiry constraints, and volume regimes act as hard-coded gates, preventing risky operations.
            </p>
          </div>
          
          <div className={`${styles.bentoCard} glass-panel`}>
            <Database className={styles.bentoIcon} />
            <h3 className={styles.bentoCardTitle}>On-Chain Consensus Oracle</h3>
            <p className={styles.bentoCardDesc}>
              Consensus probabilities, confidence, and disagreement indices are published to a keyless Move contract for third-party protocols to build upon.
            </p>
          </div>
        </div>
      </section>

      {/* Downstream Composability Interactive Demo */}
      <section id="composability" className={`${styles.section} wrap`} style={{ maxWidth: "1200px", margin: "0 auto" }}>
        <div className={styles.sectionHeader}>
          <div className={styles.eyebrow}>Composability Demo</div>
          <h2 className={styles.sectionTitle}>A reusable primitive for the Sui agent economy.</h2>
          <p className={styles.sectionDesc}>
            Interactive simulator: adjust Quorum's published consensus factors to see how a downstream Option Vault scales directional allocation dynamically.
          </p>
        </div>

        <div className={`${styles.sliderCard} glass-panel`}>
          <div className={styles.sliderControls}>
            <div className={styles.sliderGroup}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className={styles.sliderLabel}>Subjective Edge (P_subj - P_mkt)</span>
                <span className={styles.colorAccent} style={{ fontFamily: "var(--font-mono)", fontWeight: "bold" }}>+{edge.toFixed(1)}%</span>
              </div>
              <input 
                type="range" 
                min="0" 
                max="20" 
                step="0.5" 
                value={edge} 
                onChange={(e) => setEdge(parseFloat(e.target.value))} 
                className={styles.sliderInput} 
              />
            </div>

            <div className={styles.sliderGroup}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className={styles.sliderLabel}>Analyst Confidence Index</span>
                <span className={styles.colorAccent} style={{ fontFamily: "var(--font-mono)", fontWeight: "bold" }}>{confidence}%</span>
              </div>
              <input 
                type="range" 
                min="10" 
                max="100" 
                value={confidence} 
                onChange={(e) => setConfidence(parseInt(e.target.value))} 
                className={styles.sliderInput} 
              />
            </div>

            <div className={styles.sliderGroup}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className={styles.sliderLabel}>Analyst Disagreement Index</span>
                <span className={styles.colorAccent} style={{ fontFamily: "var(--font-mono)", fontWeight: "bold" }}>{disagreement}%</span>
              </div>
              <input 
                type="range" 
                min="0" 
                max="50" 
                value={disagreement} 
                onChange={(e) => setDisagreement(parseInt(e.target.value))} 
                className={styles.sliderInput} 
              />
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div className={styles.statsBlock}>
              <div className={styles.statCell}>
                <div className={styles.sliderLabel}>Consensus Read P(up)</div>
                <div className={`${styles.statVal} ${styles.colorUp}`}>{(50 + edge).toFixed(1)}%</div>
              </div>
              <div className={styles.statCell}>
                <div className={styles.sliderLabel}>Disagreement discount</div>
                <div className={styles.statVal}>{disagreement > 25 ? "⚠️ " : ""}{(trustFactor * 100).toFixed(0)}% trust</div>
              </div>
            </div>
            
            <div className={`${styles.statCell} ${styles.bgAccent}`} style={{ padding: "24px", border: "1px solid rgba(88, 166, 255, 0.2)" }}>
              <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <Layers className={styles.colorAccent} size={18} />
                <span className={styles.sliderLabel} style={{ color: "#fff" }}>Downstream Vault Action</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: "14px" }}>
                <div style={{ fontSize: "14px", color: "var(--fg-secondary)" }}>Book tilt toward UP:</div>
                <div style={{ fontSize: "28px", fontFamily: "var(--font-mono)", fontWeight: "bold", color: "#3fb950" }}>
                  {vaultAllocation}%
                </div>
              </div>
              <div style={{ fontSize: "12px", color: "var(--fg-dim)", marginTop: "10px", fontFamily: "var(--font-mono)" }}>
                sized = edge ({edge}%) × confidence ({confidence}%) × trust ({trustFactor.toFixed(2)})
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Pipeline Stages */}
      <section id="pipeline" className={`${styles.section} wrap`} style={{ maxWidth: "1200px", margin: "0 auto" }}>
        <div className={styles.sectionHeader}>
          <div className={styles.eyebrow}>Pipeline</div>
          <h2 className={styles.sectionTitle}>One stream, fully event-sourced.</h2>
          <p className={styles.sectionDesc}>
            Every run executes sequentially. Watch each stage resolve:
          </p>
        </div>

        <div className={styles.flowContainer}>
          <div className={`${styles.flowStep} glass-panel`}>
            <div className={styles.stepNumber}>01</div>
            <div className={styles.stepTitle}>Analysts</div>
            <div className={styles.stepDesc}>Volatility, momentum, catalyst, and flow evaluate current structures.</div>
          </div>
          <div className={`${styles.flowStep} glass-panel`}>
            <div className={styles.stepNumber}>02</div>
            <div className={styles.stepTitle}>Debate</div>
            <div className={styles.stepDesc}>Bull and bear models stress-test target probability forecasts.</div>
          </div>
          <div className={`${styles.flowStep} glass-panel`}>
            <div className={styles.stepNumber}>03</div>
            <div className={styles.stepTitle}>Trader</div>
            <div className={styles.stepDesc}>Calibrates analyst parameters into a unified subjective probability.</div>
          </div>
          <div className={`${styles.flowStep} glass-panel`}>
            <div className={styles.stepNumber}>04</div>
            <div className={styles.stepTitle}>Quant</div>
            <div className={styles.stepDesc}>Computes edge relative to market-implied SVI and evaluates Kelly.</div>
          </div>
          <div className={`${styles.flowStep} glass-panel`}>
            <div className={styles.stepNumber}>05</div>
            <div className={styles.stepTitle}>Risk Gate</div>
            <div className={styles.stepDesc}>Verifies exposure ceilings, regime volatility, and expiry breakers.</div>
          </div>
          <div className={`${styles.flowStep} glass-panel`}>
            <div className={styles.stepNumber}>06</div>
            <div className={styles.stepTitle}>Execute</div>
            <div className={styles.stepDesc}>Mints digital contracts directly on DeepBook Predict.</div>
          </div>
          <div className={`${styles.flowStep} glass-panel`} style={{ borderColor: "rgba(63, 185, 80, 0.3)", background: "rgba(63, 185, 80, 0.03)" }}>
            <div className={styles.stepNumber} style={{ color: "#3fb950" }}>07</div>
            <div className={styles.stepTitle} style={{ color: "#3fb950" }}>Publish</div>
            <div className={styles.stepDesc}>Publishes consensus index parameters to the Move shared state.</div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className={styles.footer}>
        <div className={styles.footerContainer}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", fontFamily: "var(--font-mono)", fontSize: "14px" }}>
            <span className={styles.colorAccent}>◢</span> QUORUM
          </div>
          <div className={styles.footerText}>
            Sui Overflow 2026 · Built by @mannyuncharted
          </div>
        </div>
      </footer>
    </div>
  );
}
