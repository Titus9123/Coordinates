import express from "express";
import cors from "cors";

const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());

app.get("/api/govmap/geocode", (req, res) => {
  const q = String(req.query.q || "").trim();

  if (!q) {
    return res.json({ results: [] });
  }

  const results = [
    {
      id: 1,
      address: q,
      X: 0,
      Y: 0,
      Lat: 31.418,
      Lon: 34.595
    }
  ];

  res.json({ results });
});

app.listen(PORT, () => {
  console.log(`GovMap proxy listening on http://localhost:${PORT}`);
});
