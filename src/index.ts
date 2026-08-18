import "dotenv/config";
import express from "express";
import travelRouter from "./routes/travel.js";
import authRouter from "./routes/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();
const PORT = Number(process.env.PORT) || 5000;

if (!process.env.JWT_SECRET?.trim()) {
  console.warn(
    "[auth] JWT_SECRET is not set — auth routes will fail until configured",
  );
}

/**
 * 解析 Content-Type: application/json 的请求
 * body 会变成普通对象挂到 req.body 上
 */
app.use(express.json());
/**
 * 解析 Content-Type: application/x-www-form-urlencoded 的请求
 * body 会变成普通对象挂到 req.body 上
 */
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

// 必须挂在所有路由之后，否则捕获不到它们抛出的错误
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
