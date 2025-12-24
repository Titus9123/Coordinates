import express from "express";
import cors from "cors";

const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());

// Shared response handler for both GET and POST
function handleGeocodeRequest(q) {
  const trimmedQ = String(q || "").trim();

  if (!trimmedQ) {
    return { results: [] };
  }

  return {
    results: [
      {
        id: 1,
        address: trimmedQ,
        X: 0,
        Y: 0,
        Lat: 31.418,
        Lon: 34.595
      }
    ]
  };
}

app.get("/geocode", (req, res) => {
  const q = String(req.query.q || "").trim();
  res.json(handleGeocodeRequest(q));
});

app.post("/geocode", (req, res) => {
  const q = String(req.body?.q || "").trim();
  res.json(handleGeocodeRequest(q));
});

app.listen(PORT, () => {
  console.log(`GovMap proxy listening on http://localhost:${PORT}`);
});
