import "dotenv/config";
import express from "express";
import travelRouter from "./routes/travel.js";
import authRouter from "./routes/auth.js";

const app = express();
const PORT = Number(process.env.PORT) || 5000;

if (!process.env.JWT_SECRET?.trim()) {
  console.warn(
    "[auth] JWT_SECRET is not set — auth routes will fail until configured",
  );
}

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

app.use("/api/auth", authRouter);
app.use("/api/travel", travelRouter);

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
