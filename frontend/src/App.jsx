import { useEffect, useState } from "react";

function App() {
  const [metrics, setMetrics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [symbol, setSymbol] = useState("BTCUSDT");

  useEffect(() => {
    const fetchData = () => {
      setLoading(true);

      fetch(
        `http://127.0.0.1:8000/metrics/latest?limit=10&symbol=${symbol}`
      )
        .then((res) => res.json())
        .then((data) => {
          setMetrics(data.data || data);
        })
        .catch((err) => console.error(err))
        .finally(() => setLoading(false));
    };

    fetchData();
    const interval = setInterval(fetchData, 3000);

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

      {loading && <p>Loading...</p>}

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
            <tr key={index} style={rowStyle}>
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
    </div>
  );
}

// Styling helpers
const headerStyle = {
  backgroundColor: "black",
  padding: "10px",
  borderBottom: "2px solid #ddd",
  textAlign: "left"
};

const cellStyle = {
  padding: "10px",
  borderBottom: "1px solid #eee"
};

const rowStyle = {
  transition: "background 0.2s"
};

export default App;
