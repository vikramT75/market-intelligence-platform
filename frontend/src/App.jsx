import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from "recharts";

function App() {
  const [metrics, setMetrics] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [symbol, setSymbol] = useState("BTCUSDT");

  // Fetch latest metrics (table)
  const fetchLatest = () => {
    setLoading(true);

    fetch(
      `http://127.0.0.1:8000/metrics/latest?limit=10&symbol=${symbol}`
    )
      .then((res) => res.json())
      .then((data) => {
        setMetrics(data.data || data);
      })
      .catch((err) => console.error("Latest fetch error:", err))
      .finally(() => setLoading(false));
  };

  // Fetch historical data (chart)
  const fetchHistory = () => {
  const now = new Date();
  const past = new Date(now.getTime() - 60 * 60 * 1000);

  const start = past.toISOString().slice(0, -1);
  const end = now.toISOString().slice(0, -1);

  fetch(
    `http://127.0.0.1:8000/metrics/history?symbol=${symbol}&start=${start}&end=${end}`
  )
    .then((res) => res.json())
    .then((data) => {
      console.log("History API response:", data);
      if (Array.isArray(data)) {
        setHistory(
          data.map((d) => ({
            ...d,
            price: Number(d.price),
            trade_time: new Date(d.trade_time).toLocaleTimeString()
          }))
        );
      } else {
        setHistory([]);
      }
    })
    .catch((err) => console.error("History fetch error:", err));
};

  useEffect(() => {
    fetchLatest();
    fetchHistory();

    const interval = setInterval(() => {
      fetchLatest();
      fetchHistory();
    }, 3000);
    return () => clearInterval(interval);
  }, [symbol]);

  return (
    <div style={{ padding: "30px", fontFamily: "Arial, sans-serif" }}>
      <h1>Market Intelligence Dashboard</h1>

      {/* Symbol Selector */}
      <div style={{ marginTop: "20px", marginBottom: "20px" }}>
        <label style={{ marginRight: "10px", fontWeight: "bold" }}>
          Select Symbol:
        </label>
        <select
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          style={{
            padding: "8px",
            borderRadius: "5px",
            border: "1px solid #ccc"
          }}
        >
          <option value="BTCUSDT">BTCUSDT</option>
          <option value="ETHUSDT">ETHUSDT</option>
        </select>
      </div>


      {/* TABLE */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          marginTop: "10px"
        }}
      >
        <thead>
          <tr>
            <th style={headerStyle}>Symbol</th>
            <th style={headerStyle}>Price</th>
            <th style={headerStyle}>Rolling Avg</th>
            <th style={headerStyle}>Return</th>
            <th style={headerStyle}>Volatility</th>
            <th style={headerStyle}>Time</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((m, index) => (
            <tr key={index}>
              <td style={cellStyle}>{m.symbol}</td>
              <td style={cellStyle}>{m.price}</td>
              <td style={cellStyle}>{m.rolling_avg_20}</td>
              <td style={cellStyle}>{m.return}</td>
              <td style={cellStyle}>{m.volatility}</td>
              <td style={cellStyle}>{m.trade_time}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* CHART */}
      <h2 style={{ marginTop: "40px" }}>Price History (Last Hour)</h2>

      {console.log("History data:", history)}

      <ResponsiveContainer width="100%" height={400}>
        <LineChart data={history}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="trade_time" tick={{ fontSize: 10 }} />
          <YAxis domain={["auto", "auto"]} />
          <Tooltip />
          <Line
            type="monotone"
            dataKey="price"
            stroke="#8884d8"
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// Styling
const headerStyle = {
  backgroundColor: "black",
  color: "white",
  padding: "10px",
  borderBottom: "2px solid #ddd",
  textAlign: "left"
};

const cellStyle = {
  padding: "10px",
  borderBottom: "1px solid #eee"
};

export default App;
