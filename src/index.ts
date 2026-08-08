import "dotenv/config";
import express from "express";
import travelRouter from "./routes/travel.js";

const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (_, res) => {
  res.send("Hello World");
});

app.get("/api/heartbeat", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: Date.now(),
  });
});

app.use("/api/travel", travelRouter);

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
