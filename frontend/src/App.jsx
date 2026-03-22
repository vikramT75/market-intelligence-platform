import { useEffect, useState, useRef, useCallback } from "react";
import {
  LineChart, BarChart,
  Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, ReferenceDot, Cell
} from "recharts";

const API     = "http://127.0.0.1:8000";
const WS_BASE = "ws://127.0.0.1:8000/ws";

// ─── Scrollbar styles ─────────────────────────────────────────────────────
const scrollbarCSS = `
  .mip-scroll::-webkit-scrollbar { width: 4px; height: 4px; }
  .mip-scroll::-webkit-scrollbar-track { background: transparent; }
  .mip-scroll::-webkit-scrollbar-thumb { background: #1e2d45; border-radius: 4px; }
  .mip-scroll::-webkit-scrollbar-thumb:hover { background: #38bdf8; }
  * { scrollbar-width: thin; scrollbar-color: #1e2d45 transparent; }
`;
if (!document.getElementById("mip-scrollbar-style")) {
  const s = document.createElement("style");
  s.id = "mip-scrollbar-style";
  s.textContent = scrollbarCSS;
  document.head.appendChild(s);
}

const C = {
  bg:      "#080c16",
  surface: "#0e1420",
  card:    "#111827",
  border:  "#1a2640",
  text:    "#e2e8f0",
  muted:   "#4a5568",
  green:   "#00e5a0",
  red:     "#ff4d6d",
  blue:    "#38bdf8",
  amber:   "#fbbf24",
  purple:  "#a78bfa",
  orange:  "#fb923c",
};

const fmt      = (n, d = 2) => n == null ? "—" : Number(n).toFixed(d);
const fmtLarge = n => n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtTime  = v => { if (!v) return ""; const d = new Date(v); return isNaN(d) ? v : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };

// ─── Lightweight Charts candlestick wrapper ───────────────────────────────
// Dynamically loads TradingView lightweight-charts from CDN
function CandlestickChart({ data, height = 240 }) {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);
  const seriesRef    = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Load lightweight-charts from CDN if not already loaded
      if (!window.LightweightCharts) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js";
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }
      if (cancelled || !containerRef.current) return;

      // Clean up previous chart
      if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; }

      // Get local timezone offset in seconds
      const tzOffsetSecs = -(new Date().getTimezoneOffset()) * 60;

      const chart = window.LightweightCharts.createChart(containerRef.current, {
        width:  containerRef.current.clientWidth,
        height: height,
        layout: { background: { color: "transparent" }, textColor: C.muted },
        grid:   { vertLines: { color: C.border }, horzLines: { color: C.border } },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: C.border },
        timeScale: {
          borderColor: C.border,
          timeVisible: true,
          secondsVisible: false,
          localization: {
            timeFormatter: ts => {
              const d = new Date((ts + tzOffsetSecs) * 1000);
              return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            },
          },
        },
        handleScroll: true,
        handleScale:  true,
        localization: {
          locale: navigator.language,
        },
      });

      chartRef.current = chart;

      const candleSeries = chart.addCandlestickSeries({
        upColor:          C.green,
        downColor:        C.red,
        borderUpColor:    C.green,
        borderDownColor:  C.red,
        wickUpColor:      C.green,
        wickDownColor:    C.red,
      });
      seriesRef.current = candleSeries;

      // Resize observer
      const ro = new ResizeObserver(() => {
        if (containerRef.current && chartRef.current) {
          chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
        }
      });
      ro.observe(containerRef.current);

      return () => ro.disconnect();
    }

    init();
    return () => { cancelled = true; };
  }, [height]);

  // Update data separately so chart isn't re-created on every data change
  useEffect(() => {
    if (!seriesRef.current || !data?.length) return;
    const tzOffsetSecs = -(new Date().getTimezoneOffset()) * 60;
    const formatted = data
      .map(d => ({
        // Subtract tz offset so lightweight-charts displays local time correctly
        time:  Math.floor(new Date(d.candle_time).getTime() / 1000) - tzOffsetSecs,
        open:  d.open,
        high:  d.high,
        low:   d.low,
        close: d.close,
      }))
      .filter(d => d.open && d.high && d.low && d.close && !isNaN(d.time))
      .sort((a, b) => a.time - b.time);

    if (formatted.length) seriesRef.current.setData(formatted);
  }, [data]);

  return <div ref={containerRef} style={{ width: "100%", height }} />;
}

// ─── Stat Row ─────────────────────────────────────────────────────────────
function StatRow({ label, value, color, border }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: border ? `1px solid ${C.border}` : "none" }}>
      <span style={{ color: C.muted, fontSize: 12 }}>{label}</span>
      <span style={{ color: color || C.text, fontFamily: "monospace", fontSize: 13, fontWeight: 700 }}>{value}</span>
    </div>
  );
}

// ─── RSI Gauge ────────────────────────────────────────────────────────────
function RSIGauge({ value }) {
  if (value == null) return <div style={{ textAlign: "center", color: C.muted, fontSize: 12, padding: "12px 0" }}>Calculating… (need 14 trades)</div>;
  const color = value > 70 ? C.red : value < 30 ? C.green : C.blue;
  const label = value > 70 ? "OVERBOUGHT" : value < 30 ? "OVERSOLD" : "NEUTRAL";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <span style={{ color, fontSize: 32, fontFamily: "monospace", fontWeight: 800 }}>{fmt(value)}</span>
        <span style={{ color, fontSize: 10, fontWeight: 700, letterSpacing: "0.12em" }}>{label}</span>
      </div>
      <div style={{ position: "relative", height: 6, background: C.border, borderRadius: 4 }}>
        <div style={{ position: "absolute", left: 0, width: "30%", height: "100%", background: C.green + "33", borderRadius: "4px 0 0 4px" }} />
        <div style={{ position: "absolute", left: "70%", width: "30%", height: "100%", background: C.red + "33", borderRadius: "0 4px 4px 0" }} />
        <div style={{ position: "absolute", top: "50%", transform: "translate(-50%,-50%)", left: `${Math.min(Math.max(value,0),100)}%`, width: 12, height: 12, borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}`, transition: "left 0.4s ease" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10, color: C.muted }}>
        <span>0</span><span>30</span><span>70</span><span>100</span>
      </div>
    </div>
  );
}

function PctBadge({ value, size = 13 }) {
  if (value == null) return <span style={{ color: C.muted }}>—</span>;
  const pos = value >= 0;
  return <span style={{ color: pos ? C.green : C.red, fontWeight: 700, fontSize: size }}>{pos ? "▲" : "▼"} {Math.abs(value).toFixed(3)}%</span>;
}

// ─── Tooltips ─────────────────────────────────────────────────────────────
function LineTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", fontSize: 12 }}>
      <div style={{ color: C.muted, marginBottom: 6 }}>{label}</div>
      <div style={{ color: C.blue }}>Price: <strong>${fmtLarge(d?.price)}</strong></div>
      <div style={{ color: C.purple }}>MA₂₀: <strong>${fmtLarge(d?.rolling_avg_20)}</strong></div>
    </div>
  );
}

function RSITooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const v = payload[0]?.value;
  const color = v > 70 ? C.red : v < 30 ? C.green : C.blue;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", fontSize: 12 }}>
      <div style={{ color: C.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ color }}>RSI: <strong>{fmt(v)}</strong></div>
    </div>
  );
}

function VolumeTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", fontSize: 12 }}>
      <div style={{ color: C.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ color: C.green }}>Volume: <strong>{fmtLarge(payload[0]?.value)}</strong></div>
    </div>
  );
}

// ─── Signal Badge ────────────────────────────────────────────────────────
function SignalBadge({ signal, strength, size = "normal" }) {
  if (!signal || signal === "NEUTRAL") return (
    <span style={{ color: C.muted, fontSize: 11, fontWeight: 600 }}>— NEUTRAL</span>
  );
  const isBuy   = signal === "BUY";
  const color   = isBuy ? C.green : C.red;
  const icon    = isBuy ? "▲" : "▼";
  const isLarge = size === "large";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: isLarge ? "4px 12px" : "2px 8px",
      borderRadius: 20,
      background: color + "22",
      border: `1px solid ${color}55`,
      color, fontWeight: 800,
      fontSize: isLarge ? 13 : 11,
      letterSpacing: "0.08em",
    }}>
      {icon} {signal}
      {strength === "STRONG" && (
        <span style={{ fontSize: 9, background: color + "33", padding: "1px 5px", borderRadius: 10, marginLeft: 2 }}>
          STRONG
        </span>
      )}
    </span>
  );
}

// ─── Toggle Button ────────────────────────────────────────────────────────
function ToggleBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: "3px 10px", borderRadius: 5, fontSize: 11, fontWeight: 700,
      cursor: "pointer", border: `1px solid ${active ? C.blue : C.border}`,
      background: active ? C.blue + "22" : "transparent",
      color: active ? C.blue : C.muted, transition: "all 0.15s",
    }}>{children}</button>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────
export default function App() {
  const [symbol, setSymbol]             = useState("BTCUSDT");
  const [inputVal, setInputVal]         = useState("BTCUSDT");
  const [availableSymbols, setAvailableSymbols] = useState(["BTCUSDT"]);
  const [live, setLive]                 = useState(null);
  const [history, setHistory]           = useState([]);
  const [recentTrades, setRecentTrades] = useState([]);
  const [wsStatus, setWsStatus]         = useState("connecting");
  const [timeframe, setTimeframe]       = useState("1m");
  const [candleData, setCandleData]     = useState([]);
  const [chartMode, setChartMode]       = useState("line"); // "line" | "candle"

  const wsRef         = useRef(null);
  const reconnectRef  = useRef(null);
  const destroyedRef  = useRef(false);
  const latestDataRef = useRef(null);
  const lastChartPush = useRef(0);
  const lastSignalRef = useRef({ signal: "NEUTRAL", signal_strength: "WEAK" });

  // ── Resizable panel ───────────────────────────────────────────────────────
  const [rightWidth, setRightWidth] = useState(300);
  const isDragging  = useRef(false);
  const dragStartX  = useRef(0);
  const dragStartW  = useRef(0);

  useEffect(() => {
    const onMove = (e) => {
      if (!isDragging.current) return;
      const dx   = dragStartX.current - e.clientX;
      const newW = Math.min(500, Math.max(200, dragStartW.current + dx));
      setRightWidth(newW);
    };
    const onUp = () => { isDragging.current = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  const startDrag = (e) => {
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartW.current = rightWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // ── Symbols ────────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${API}/symbols`).then(r => r.json()).then(d => { if (d.symbols?.length) setAvailableSymbols(d.symbols); }).catch(() => {});
  }, []);

  // ── History (line chart) ──────────────────────────────────────────────────
  const fetchHistory = useCallback(() => {
    const now  = new Date();
    const past = new Date(now.getTime() - 10 * 60 * 1000);
    fetch(`${API}/metrics/history?symbol=${symbol}&start=${past.toISOString().slice(0,-1)}&end=${now.toISOString().slice(0,-1)}`)
      .then(r => r.json())
      .then(data => {
        if (!Array.isArray(data)) return;
        const step    = Math.max(1, Math.floor(data.length / 100));
        const sampled = data.filter((_, i) => i % step === 0).slice(-100);
        setHistory(sampled.map(d => ({
          price:           Number(d.price),
          rolling_avg_20:  Number(d.rolling_avg_20),
          rsi:             d.rsi != null ? Number(d.rsi) : null,
          volume:          Number(d.volume),
          signal:          d.signal,
          signal_strength: d.signal_strength,
          trade_time:      new Date(d.trade_time).toLocaleTimeString(),
        })));
      }).catch(() => {});
  }, [symbol]);

  // ── Candles ────────────────────────────────────────────────────────────────
  const fetchCandles = useCallback(() => {
    fetch(`${API}/metrics/candles?symbol=${symbol}&timeframe=${timeframe}`)
      .then(r => r.json())
      .then(d => { if (d.candles?.length) setCandleData(d.candles); })
      .catch(() => {});
  }, [symbol, timeframe]);

  const fetchRecent = useCallback(() => {
    fetch(`${API}/metrics/latest?symbol=${symbol}&limit=10`)
      .then(r => r.json())
      .then(d => setRecentTrades(d.data || []))
      .catch(() => {});
  }, [symbol]);

  useEffect(() => {
    setHistory([]); setCandleData([]); setLive(null); latestDataRef.current = null;
    fetchHistory(); fetchRecent(); fetchCandles();
  }, [fetchHistory, fetchRecent, fetchCandles]);

  useEffect(() => {
    const t = setInterval(fetchCandles, 30000);
    return () => clearInterval(t);
  }, [fetchCandles]);

  // Re-fetch candles immediately when switching to candle mode
  useEffect(() => {
    if (chartMode === "candle") fetchCandles();
  }, [chartMode, fetchCandles]);

  // ── WebSocket + render loop ────────────────────────────────────────────────
  useEffect(() => {
    destroyedRef.current = false;

    function connect() {
      if (destroyedRef.current) return;
      setWsStatus("connecting");
      const ws = new WebSocket(`${WS_BASE}/${symbol}`);
      wsRef.current = ws;
      ws.onopen  = () => setWsStatus("live");
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (destroyedRef.current) return;
        setWsStatus("disconnected");
        reconnectRef.current = setTimeout(connect, 2000);
      };
      ws.onmessage = (e) => { latestDataRef.current = JSON.parse(e.data); };
    }
    connect();

    const renderLoop = setInterval(() => {
      const data = latestDataRef.current;
      if (!data) return;
      // Hold last non-neutral signal so it stays visible between ticks
      if (data.signal && data.signal !== "NEUTRAL") {
        lastSignalRef.current = { signal: data.signal, signal_strength: data.signal_strength };
      }
      setLive({ ...data, signal: lastSignalRef.current.signal, signal_strength: lastSignalRef.current.signal_strength });
      setRecentTrades(prev => {
        if (prev[0]?.trade_time === data.trade_time) return prev;
        return [data, ...prev].slice(0, 10);
      });
      const now = Date.now();
      if (now - lastChartPush.current >= 3000) {
        lastChartPush.current = now;
        const point = {
          price: Number(data.price), rolling_avg_20: Number(data.rolling_avg_20),
          rsi: data.rsi != null ? Number(data.rsi) : null,
          volume: Number(data.volume),
          signal: data.signal,
          signal_strength: data.signal_strength,
          trade_time: new Date(data.trade_time).toLocaleTimeString(),
        };
        setHistory(prev => {
          if (prev.length && prev[prev.length-1].price === point.price) return prev;
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
    if (val) setSymbol(val);
  };

  const statusColor  = { live: C.green, connecting: C.amber, disconnected: C.red, error: C.red }[wsStatus] || C.muted;
  const priceChange  = live?.change_24h_pct;
  const priceColor   = priceChange == null ? C.text : priceChange >= 0 ? C.green : C.red;
  const timeframeLabel = { "1m": "last 1h", "5m": "last 6h", "15m": "last 12h", "1h": "last 48h" }[timeframe];

  return (
    <div style={{ minHeight: "100vh", width: "100%", background: C.bg, color: C.text, fontFamily: "'Inter', sans-serif", boxSizing: "border-box" }}>

      {/* ── Top Bar ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 28px", borderBottom: `1px solid ${C.border}`, background: C.surface, position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.2em", color: C.blue, textTransform: "uppercase" }}>MIP</span>
          <div style={{ width: 1, height: 20, background: C.border }} />
          <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.5px" }}>{symbol}</span>
          {live && <>
            <span style={{ fontFamily: "monospace", fontSize: 18, fontWeight: 700, color: priceColor }}>${fmtLarge(live.price)}</span>
            <PctBadge value={priceChange} size={13} />
          </>}
          <span style={{ fontSize: 10, padding: "2px 10px", borderRadius: 20, background: statusColor + "22", color: statusColor, border: `1px solid ${statusColor}44`, fontWeight: 700, letterSpacing: "0.1em" }}>
            ● {wsStatus.toUpperCase()}
          </span>
          {live?.signal && live.signal !== "NEUTRAL" && (
            <SignalBadge signal={live.signal} strength={live.signal_strength} />
          )}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {availableSymbols.map(s => (
            <button key={s} onClick={() => { setSymbol(s); setInputVal(s); }}
              style={{ padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", background: symbol === s ? C.blue + "22" : "transparent", color: symbol === s ? C.blue : C.muted, border: `1px solid ${symbol === s ? C.blue : C.border}` }}>
              {s}
            </button>
          ))}
          <input value={inputVal} onChange={e => setInputVal(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && handleSymbolSubmit()} placeholder="SOLUSDT…"
            style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 10px", color: C.text, fontSize: 12, width: 100, outline: "none", fontFamily: "monospace" }} />
          <button onClick={handleSymbolSubmit} style={{ background: C.blue + "22", border: `1px solid ${C.blue}`, color: C.blue, borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>GO</button>
        </div>
      </div>

      {/* ── Main Grid ── */}
      <div style={{ display: "flex", height: "calc(100vh - 53px)", overflow: "hidden" }}>

        {/* ── LEFT ── */}
        <div className="mip-scroll" style={{ flex: 1, overflowY: "auto", padding: "20px 20px 20px 24px", display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>

          {/* ── Price Chart ── */}
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "16px 20px" }}>
            {/* Chart header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Price</span>
                <span style={{ color: C.muted, fontSize: 12, marginLeft: 8 }}>
                  {chartMode === "line" ? "last 10 min" : timeframeLabel}
                </span>
              </div>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>

                {/* Chart type toggle — only shown when candle mode or switching */}
                <ToggleBtn active={chartMode === "line"} onClick={() => setChartMode("line")}>
                  ╱ Line
                </ToggleBtn>
                <ToggleBtn active={chartMode === "candle"} onClick={() => setChartMode("candle")}>
                  ▌Candle
                </ToggleBtn>

                {/* Timeframe buttons — only relevant in candle mode */}
                {chartMode === "candle" && (
                  <>
                    <div style={{ width: 1, height: 16, background: C.border, margin: "0 4px" }} />
                    {["1m","5m","15m","1h"].map(tf => (
                      <ToggleBtn key={tf} active={timeframe === tf} onClick={() => setTimeframe(tf)}>{tf}</ToggleBtn>
                    ))}
                  </>
                )}

                {/* Legend */}
                <div style={{ width: 1, height: 16, background: C.border, margin: "0 4px" }} />
                {chartMode === "line"
                  ? <><span style={{ color: C.blue, fontSize: 11 }}>— Price</span><span style={{ color: C.purple, fontSize: 11 }}>--- MA₂₀</span></>
                  : <><span style={{ color: C.green, fontSize: 11 }}>▌ Up</span><span style={{ color: C.red, fontSize: 11 }}>▌ Down</span></>
                }
              </div>
            </div>

            {/* Chart body */}
            {chartMode === "line" ? (
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={history} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis dataKey="trade_time" tick={{ fontSize: 9, fill: C.muted }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis domain={["auto","auto"]} tick={{ fontSize: 9, fill: C.muted }} tickLine={false} axisLine={false} tickFormatter={v => `$${fmtLarge(v)}`} width={78} />
                  <Tooltip content={<LineTooltip />} />
                  <Line type="monotone" dataKey="price"          stroke={C.blue}   dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="rolling_avg_20" stroke={C.purple} dot={false} strokeWidth={1.5} strokeDasharray="5 3" />
                  {/* Signal markers */}
                  {history.filter(d => d.signal && d.signal !== "NEUTRAL").map((d, i) => (
                    <ReferenceDot key={i} x={d.trade_time} y={d.price}
                      r={d.signal_strength === "STRONG" ? 6 : 4}
                      fill={d.signal === "BUY" ? C.green : C.red}
                      stroke={C.bg} strokeWidth={1.5}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <CandlestickChart data={candleData} height={240} />
            )}
          </div>

          {/* ── RSI Chart ── */}
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "16px 20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <span style={{ fontSize: 13, fontWeight: 600 }}>RSI (14)</span>
                <span style={{ color: C.muted, fontSize: 12, marginLeft: 8 }}>relative strength index</span>
              </div>
              <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
                <span style={{ color: C.green }}>── 30 Oversold</span>
                <span style={{ color: C.red }}>── 70 Overbought</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={140}>
              <LineChart data={history} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="trade_time" tick={{ fontSize: 9, fill: C.muted }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis domain={[0,100]} tick={{ fontSize: 9, fill: C.muted }} tickLine={false} axisLine={false} width={30} ticks={[0,30,50,70,100]} />
                <Tooltip content={<RSITooltip />} />
                <ReferenceLine y={70} stroke={C.red}   strokeDasharray="4 2" strokeOpacity={0.6} />
                <ReferenceLine y={30} stroke={C.green} strokeDasharray="4 2" strokeOpacity={0.6} />
                <ReferenceLine y={50} stroke={C.muted} strokeDasharray="2 4" strokeOpacity={0.4} />
                <Line type="monotone" dataKey="rsi" stroke={C.amber} dot={false} strokeWidth={2} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* ── Volume Chart ── */}
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "16px 20px" }}>
            <div style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Volume</span>
              <span style={{ color: C.muted, fontSize: 12, marginLeft: 8 }}>cumulative per tick</span>
            </div>
            <ResponsiveContainer width="100%" height={120}>
              <BarChart data={history} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                <XAxis dataKey="trade_time" tick={{ fontSize: 9, fill: C.muted }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9, fill: C.muted }} tickLine={false} axisLine={false} width={50} tickFormatter={v => fmtLarge(v)} />
                <Tooltip content={<VolumeTooltip />} />
                <Bar dataKey="volume" radius={[2,2,0,0]}>
                  {history.map((_, i) => <Cell key={i} fill={i === history.length-1 ? C.green : C.green + "55"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* ── Recent Trades ── */}
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "12px 20px", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Recent Trades</span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    {["Price","MA₂₀","Return","RSI","Volume","24h Δ","Signal","Time"].map(h => (
                      <th key={h} style={{ padding: "8px 14px", color: C.muted, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recentTrades.map((m, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, background: i === 0 ? C.blue + "0a" : "transparent" }}>
                      <td style={{ padding: "8px 14px", fontFamily: "monospace", fontWeight: 700 }}>${fmtLarge(m.price)}</td>
                      <td style={{ padding: "8px 14px", fontFamily: "monospace", color: C.purple }}>${fmtLarge(m.rolling_avg_20)}</td>
                      <td style={{ padding: "8px 14px" }}><PctBadge value={m.return != null ? m.return * 100 : null} /></td>
                      <td style={{ padding: "8px 14px", fontFamily: "monospace", color: m.rsi > 70 ? C.red : m.rsi < 30 ? C.green : C.blue }}>{m.rsi != null ? fmt(m.rsi) : "—"}</td>
                      <td style={{ padding: "8px 14px", fontFamily: "monospace", color: C.green }}>{fmtLarge(m.volume)}</td>
                      <td style={{ padding: "8px 14px" }}><PctBadge value={m.change_24h_pct} /></td>
                      <td style={{ padding: "8px 14px" }}><SignalBadge signal={m.signal} strength={m.signal_strength} /></td>
                      <td style={{ padding: "8px 14px", color: C.muted, fontSize: 11 }}>{m.trade_time ? new Date(m.trade_time).toLocaleTimeString() : "—"}</td>
                    </tr>
                  ))}
                  {recentTrades.length === 0 && (
                    <tr><td colSpan={7} style={{ padding: "20px", textAlign: "center", color: C.muted }}>Waiting for data…</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ── Drag Handle ── */}
        <div onMouseDown={startDrag}
          style={{ width: 4, cursor: "col-resize", background: C.border, transition: "background 0.15s", flexShrink: 0 }}
          onMouseEnter={e => e.currentTarget.style.background = C.blue}
          onMouseLeave={e => e.currentTarget.style.background = C.border}
        />

        {/* ── RIGHT: Stats Panel ── */}
        <div className="mip-scroll" style={{ width: rightWidth, flexShrink: 0, overflowY: "auto", padding: "20px 16px", display: "flex", flexDirection: "column", gap: 16, background: C.surface }}>

          {/* Live Price */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderTop: `2px solid ${C.blue}`, borderRadius: 10, padding: "16px" }}>
            <div style={{ color: C.muted, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>Live Price</div>
            <div style={{ fontFamily: "monospace", fontSize: 26, fontWeight: 800, color: priceColor, lineHeight: 1 }}>${fmtLarge(live?.price)}</div>
            <div style={{ marginTop: 6 }}><PctBadge value={priceChange} /></div>
          </div>

          {/* Signal */}
          <div style={{
            background: C.card, border: `1px solid ${C.border}`,
            borderTop: `2px solid ${
              !live?.signal || live.signal === "NEUTRAL" ? C.muted
              : live.signal === "BUY" ? C.green : C.red
            }`,
            borderRadius: 10, padding: "16px"
          }}>
            <div style={{ color: C.muted, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Signal</div>
            <div style={{ marginBottom: 10 }}>
              <SignalBadge signal={live?.signal} strength={live?.signal_strength} size="large" />
            </div>
            {live?.signal && live.signal !== "NEUTRAL" && (
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
                {live.signal_strength === "STRONG"
                  ? "Both MA crossover and RSI agree"
                  : "Single indicator trigger"}
              </div>
            )}
            {(!live?.signal || live.signal === "NEUTRAL") && (
              <div style={{ fontSize: 11, color: C.muted }}>No active signal</div>
            )}
          </div>

          {/* RSI Gauge */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderTop: `2px solid ${C.amber}`, borderRadius: 10, padding: "16px" }}>
            <div style={{ color: C.muted, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>RSI (14)</div>
            <RSIGauge value={live?.rsi} />
          </div>

          {/* Market Stats */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderTop: `2px solid ${C.purple}`, borderRadius: 10, padding: "16px" }}>
            <div style={{ color: C.muted, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>Market Stats</div>
            <StatRow label="Rolling Avg (20)" value={live ? `$${fmtLarge(live.rolling_avg_20)}` : "—"} color={C.purple} border />
            <StatRow label="Volatility (σ)"   value={live ? fmt(live.volatility, 4) : "—"} color={C.amber} border />
            <StatRow label="Volume"           value={live ? fmtLarge(live.volume) : "—"} color={C.green} border />
            <StatRow label="Trade Count"      value={live ? live.trade_count?.toLocaleString() : "—"} color={C.blue} border />
            <StatRow label="Return (last)"    value={live?.return != null ? `${(live.return*100).toFixed(4)}%` : "—"} color={live?.return >= 0 ? C.green : C.red} />
          </div>

          {/* Quant Metrics */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderTop: `2px solid ${C.orange}`, borderRadius: 10, padding: "16px" }}>
            <div style={{ color: C.muted, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>Quant</div>

            {/* Sharpe Ratio */}
            <div style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: C.muted, fontSize: 12 }}>Sharpe Ratio</span>
                <span style={{
                  fontFamily: "monospace", fontSize: 13, fontWeight: 700,
                  color: live?.sharpe == null ? C.muted
                       : live.sharpe >= 1  ? C.green
                       : live.sharpe >= 0  ? C.amber
                       : C.red
                }}>
                  {live?.sharpe != null ? fmt(live.sharpe, 3) : "—"}
                </span>
              </div>
              {live?.sharpe != null && (
                <div style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>
                  {live.sharpe >= 2 ? "Excellent (>2)" : live.sharpe >= 1 ? "Good (1–2)" : live.sharpe >= 0 ? "Subpar (0–1)" : "Negative (<0)"}
                </div>
              )}
              {live?.sharpe == null && (
                <div style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>Need 30 trades to calculate</div>
              )}
            </div>

            {/* Max Drawdown */}
            <div style={{ padding: "10px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: C.muted, fontSize: 12 }}>Max Drawdown</span>
                <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 700, color: live?.max_drawdown < -1 ? C.red : live?.max_drawdown < 0 ? C.amber : C.muted }}>
                  {live?.max_drawdown != null ? `${fmt(live.max_drawdown, 3)}%` : "—"}
                </span>
              </div>
              {live?.max_drawdown != null && (
                <div style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>
                  Peak-to-trough since session start
                </div>
              )}
            </div>
          </div>

          {/* Session */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderTop: `2px solid ${C.green}`, borderRadius: 10, padding: "16px" }}>
            <div style={{ color: C.muted, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>Session</div>
            <StatRow label="Symbol"    value={symbol} color={C.blue} border />
            <StatRow label="Status"    value={wsStatus.toUpperCase()} color={statusColor} border />
            <StatRow label="Last tick" value={live?.trade_time ? new Date(live.trade_time).toLocaleTimeString() : "—"} />
          </div>

          {/* Footer */}
          <div style={{ marginTop: "auto", paddingTop: 12, borderTop: `1px solid ${C.border}`, fontSize: 10, color: C.muted, lineHeight: 1.8 }}>
            <div>MARKET INTELLIGENCE PLATFORM</div>
            <div>BINANCE WS → KAFKA → FASTAPI</div>
          </div>
        </div>
      </div>
    </div>
  );
}