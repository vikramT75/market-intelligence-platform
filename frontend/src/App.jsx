import { useEffect, useState, useRef, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer
} from "recharts";

const API     = "http://127.0.0.1:8000";
const WS_BASE = "ws://127.0.0.1:8000/ws";

// ─── Colour palette ───────────────────────────────────────────────────────
const C = {
  bg:      "#0a0e1a",
  surface: "#111827",
  border:  "#1e2d45",
  text:    "#e2e8f0",
  muted:   "#64748b",
  green:   "#00e5a0",
  red:     "#ff4d6d",
  blue:    "#38bdf8",
  amber:   "#fbbf24",
  purple:  "#a78bfa",
};

// ─── Helpers ──────────────────────────────────────────────────────────────
const fmt      = (n, d = 2) => n == null ? "—" : Number(n).toFixed(d);
const fmtLarge = n => n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

function PctBadge({ value }) {
  if (value == null) return <span style={{ color: C.muted }}>—</span>;
  const pos = value >= 0;
  return (
    <span style={{ color: pos ? C.green : C.red, fontWeight: 700 }}>
      {pos ? "▲" : "▼"} {Math.abs(value).toFixed(3)}%
    </span>
  );
}

function RSIBar({ value }) {
  if (value == null) return <span style={{ color: C.muted }}>Calculating…</span>;
  const color = value > 70 ? C.red : value < 30 ? C.green : C.blue;
  const label = value > 70 ? "Overbought" : value < 30 ? "Oversold" : "Neutral";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color, fontWeight: 700, fontSize: 20 }}>{fmt(value)}</span>
        <span style={{ color, fontSize: 12, alignSelf: "flex-end", marginBottom: 2 }}>{label}</span>
      </div>
      <div style={{ height: 4, background: C.border, borderRadius: 4 }}>
        <div style={{
          height: "100%", width: `${value}%`, borderRadius: 4,
          background: `linear-gradient(90deg, ${C.blue}, ${color})`,
          transition: "width 0.4s ease"
        }} />
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub, accent, large }) {
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderTop: `2px solid ${accent}`, borderRadius: 10,
      padding: "18px 22px", minWidth: 0, flex: 1,
    }}>
      <div style={{ color: C.muted, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ color: C.text, fontSize: large ? 28 : 22, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, lineHeight: 1 }}>
        {value}
      </div>
      {sub && <div style={{ marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", fontSize: 12 }}>
      <div style={{ color: C.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ color: C.blue }}>Price: <strong>${fmtLarge(d.price)}</strong></div>
      <div style={{ color: C.purple }}>Avg₂₀: <strong>${fmtLarge(d.rolling_avg_20)}</strong></div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────
export default function App() {
  const [symbol, setSymbol]               = useState("BTCUSDT");
  const [inputVal, setInputVal]           = useState("BTCUSDT");
  const [availableSymbols, setAvailableSymbols] = useState(["BTCUSDT", "ETHUSDT"]);
  const [live, setLive]                   = useState(null);
  const [history, setHistory]             = useState([]);
  const [recentTrades, setRecentTrades]   = useState([]);
  const [wsStatus, setWsStatus]           = useState("connecting");

  const wsRef          = useRef(null);
  const reconnectRef   = useRef(null);
  const destroyedRef   = useRef(false);
  const latestDataRef  = useRef(null);  // always holds the latest ws message, never cleared
  const lastChartPush  = useRef(0);

  // ── Fetch available symbols ──────────────────────────────────────────────
  useEffect(() => {
    fetch(`${API}/symbols`)
      .then(r => r.json())
      .then(d => { if (d.symbols?.length) setAvailableSymbols(d.symbols); })
      .catch(() => {});
  }, []);

  // ── Initial history load from REST (once per symbol) ─────────────────────
  const fetchHistory = useCallback(() => {
    const now  = new Date();
    const past = new Date(now.getTime() - 10 * 60 * 1000); // last 10 min
    fetch(`${API}/metrics/history?symbol=${symbol}&start=${past.toISOString().slice(0,-1)}&end=${now.toISOString().slice(0,-1)}`)
      .then(r => r.json())
      .then(data => {
        if (!Array.isArray(data)) return;
        // Subsample to max 100 points
        const step    = Math.max(1, Math.floor(data.length / 100));
        const sampled = data.filter((_, i) => i % step === 0).slice(-100);
        setHistory(sampled.map(d => ({
          price:          Number(d.price),
          rolling_avg_20: Number(d.rolling_avg_20),
          trade_time:     new Date(d.trade_time).toLocaleTimeString(),
        })));
      })
      .catch(() => {});
  }, [symbol]);

  const fetchRecent = useCallback(() => {
    fetch(`${API}/metrics/latest?symbol=${symbol}&limit=15`)
      .then(r => r.json())
      .then(d => setRecentTrades(d.data || []))
      .catch(() => {});
  }, [symbol]);

  useEffect(() => {
    fetchHistory();
    fetchRecent();
  }, [fetchHistory, fetchRecent]);

  // ── WebSocket + throttled render loop ────────────────────────────────────
  useEffect(() => {
    destroyedRef.current = false;

    function connect() {
      if (destroyedRef.current) return;
      setWsStatus("connecting");
      const ws = new WebSocket(`${WS_BASE}/${symbol}`);
      wsRef.current = ws;

      ws.onopen  = () => setWsStatus("live");
      ws.onerror = () => { ws.close(); };
      ws.onclose = () => {
        if (destroyedRef.current) return;
        setWsStatus("disconnected");
        reconnectRef.current = setTimeout(connect, 2000);
      };

      // Just store — never clear, so cards never go blank
      ws.onmessage = (e) => {
        latestDataRef.current = JSON.parse(e.data);
      };
    }

    connect();

    // Render loop: cards at 1fps, chart every 3s
    const renderLoop = setInterval(() => {
      const data = latestDataRef.current;
      if (!data) return;

      // Cards + table update every 1s
      setLive({ ...data });
      setRecentTrades(prev => {
        if (prev[0]?.trade_time === data.trade_time) return prev;
        return [data, ...prev].slice(0, 15);
      });

      // Chart updates every 3s
      const now = Date.now();
      if (now - lastChartPush.current >= 3000) {
        lastChartPush.current = now;
        const point = {
          price:          Number(data.price),
          rolling_avg_20: Number(data.rolling_avg_20),
          trade_time:     new Date(data.trade_time).toLocaleTimeString(),
        };
        setHistory(prev => {
          if (prev.length && prev[prev.length - 1].price === point.price) return prev;
          return [...prev, point].slice(-100);
        });
      }
    }, 1000);

    return () => {
      destroyedRef.current = true;
      clearTimeout(reconnectRef.current);
      clearInterval(renderLoop);
      if (wsRef.current) wsRef.current.close();
    };
  }, [symbol]);

  const handleSymbolSubmit = () => {
    const val = inputVal.trim().toUpperCase();
    if (val) { setSymbol(val); latestDataRef.current = null; }
  };

  const statusColor = { live: C.green, connecting: C.amber, disconnected: C.red, error: C.red }[wsStatus] || C.muted;

  return (
    <div style={{ minHeight: "100vh", width: "100%", background: C.bg, color: C.text, fontFamily: "'Inter', sans-serif", padding: "28px 32px", boxSizing: "border-box" }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.15em", color: C.blue, textTransform: "uppercase" }}>
              Market Intelligence
            </span>
            <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, background: statusColor + "22", color: statusColor, border: `1px solid ${statusColor}55`, fontWeight: 600 }}>
              ● {wsStatus.toUpperCase()}
            </span>
          </div>
          <h1 style={{ margin: "4px 0 0", fontSize: 26, fontWeight: 800, letterSpacing: "-0.5px" }}>
            {symbol}
            <span style={{ color: C.muted, fontWeight: 400, fontSize: 16, marginLeft: 10 }}>/ Real-Time Dashboard</span>
          </h1>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {availableSymbols.map(s => (
              <button key={s} onClick={() => { setSymbol(s); setInputVal(s); latestDataRef.current = null; }}
                style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.15s", background: symbol === s ? C.blue + "22" : "transparent", color: symbol === s ? C.blue : C.muted, border: `1px solid ${symbol === s ? C.blue : C.border}` }}>
                {s}
              </button>
            ))}
          </div>
          <input value={inputVal} onChange={e => setInputVal(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && handleSymbolSubmit()} placeholder="SOLUSDT…"
            style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 12px", color: C.text, fontSize: 13, width: 110, outline: "none", fontFamily: "'JetBrains Mono', monospace" }} />
          <button onClick={handleSymbolSubmit} style={{ background: C.blue + "22", border: `1px solid ${C.blue}`, color: C.blue, borderRadius: 6, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>GO</button>
        </div>
      </div>

      {/* ── Metric Cards ── */}
      <div style={{ display: "flex", gap: 14, marginBottom: 24, flexWrap: "wrap" }}>
        <MetricCard label="Live Price"       accent={C.blue}   large value={live ? `$${fmtLarge(live.price)}` : "—"} sub={<PctBadge value={live?.change_24h_pct} />} />
        <MetricCard label="Rolling Avg (20)" accent={C.purple}       value={live ? `$${fmtLarge(live.rolling_avg_20)}` : "—"} sub={<span style={{ color: C.muted, fontSize: 12 }}>20-trade window</span>} />
        <MetricCard label="RSI (14)"         accent={live?.rsi > 70 ? C.red : live?.rsi < 30 ? C.green : C.blue} value={<RSIBar value={live?.rsi} />} />
        <MetricCard label="Volatility (σ)"   accent={C.amber}        value={live ? fmt(live.volatility, 2) : "—"} sub={<span style={{ color: C.muted, fontSize: 12 }}>Std dev (20 trades)</span>} />
        <MetricCard label="Volume"           accent={C.green}        value={live ? fmtLarge(live.volume) : "—"} sub={<span style={{ color: C.muted, fontSize: 12 }}>Cumulative session</span>} />
        <MetricCard label="Trade Count"      accent={C.purple}       value={live ? live.trade_count?.toLocaleString() : "—"} sub={<span style={{ color: C.muted, fontSize: 12 }}>This session</span>} />
      </div>

      {/* ── Chart ── */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "20px 24px", marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: C.text }}>
            Price History <span style={{ color: C.muted, fontWeight: 400 }}>— last 10 min</span>
          </h2>
          <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
            <span style={{ color: C.blue }}>— Price</span>
            <span style={{ color: C.purple }}>— Avg₂₀</span>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={history} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis dataKey="trade_time" tick={{ fontSize: 10, fill: C.muted }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: C.muted }} tickLine={false} axisLine={false} tickFormatter={v => `$${fmtLarge(v)}`} width={80} />
            <Tooltip content={<ChartTooltip />} />
            <Line type="monotone" dataKey="price"          stroke={C.blue}   dot={false} strokeWidth={2} />
            <Line type="monotone" dataKey="rolling_avg_20" stroke={C.purple} dot={false} strokeWidth={1.5} strokeDasharray="4 2" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* ── Recent Trades Table ── */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "16px 24px", borderBottom: `1px solid ${C.border}` }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Recent Trades</h2>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {["Symbol","Price","Avg₂₀","Return","Volatility","RSI","Volume","24h Δ","Time"].map(h => (
                  <th key={h} style={{ padding: "10px 16px", color: C.muted, fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentTrades.map((m, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, background: i === 0 ? C.blue + "08" : "transparent", transition: "background 0.3s" }}>
                  <td style={{ padding: "10px 16px", color: C.blue, fontWeight: 700, fontFamily: "monospace" }}>{m.symbol}</td>
                  <td style={{ padding: "10px 16px", fontFamily: "monospace", fontWeight: 600 }}>${fmtLarge(m.price)}</td>
                  <td style={{ padding: "10px 16px", color: C.purple, fontFamily: "monospace" }}>${fmtLarge(m.rolling_avg_20)}</td>
                  <td style={{ padding: "10px 16px" }}><PctBadge value={m.return != null ? m.return * 100 : null} /></td>
                  <td style={{ padding: "10px 16px", color: C.amber, fontFamily: "monospace" }}>{fmt(m.volatility)}</td>
                  <td style={{ padding: "10px 16px", fontFamily: "monospace", color: m.rsi > 70 ? C.red : m.rsi < 30 ? C.green : C.blue }}>{m.rsi != null ? fmt(m.rsi) : "—"}</td>
                  <td style={{ padding: "10px 16px", color: C.green, fontFamily: "monospace" }}>{fmtLarge(m.volume)}</td>
                  <td style={{ padding: "10px 16px" }}><PctBadge value={m.change_24h_pct} /></td>
                  <td style={{ padding: "10px 16px", color: C.muted, fontSize: 12 }}>{m.trade_time ? new Date(m.trade_time).toLocaleTimeString() : "—"}</td>
                </tr>
              ))}
              {recentTrades.length === 0 && (
                <tr><td colSpan={9} style={{ padding: "24px", textAlign: "center", color: C.muted }}>Waiting for data…</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{ marginTop: 20, textAlign: "center", color: C.muted, fontSize: 11, letterSpacing: "0.05em" }}>
        MARKET INTELLIGENCE PLATFORM · DATA VIA BINANCE WS · BUILT WITH FASTAPI + KAFKA
      </div>
    </div>
  );
}