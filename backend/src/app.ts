import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import mongoose from 'mongoose';
import { env, projectRoot, allowedOrigins } from './config/env.js';
import { api } from './routes/index.js';
import { checkOrigin, errorHandler } from './middleware/security.js';
import { ApiError } from './utils/core.js';

export const app = express();
app.disable('x-powered-by');
if (env.trustProxy) app.set('trust proxy', env.trustProxy);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: env.production ? [] : null,
      },
    },
  }),
);
app.use(
  cors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
    credentials: true,
  }),
);
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
app.use('/api', checkOrigin);
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    limit: env.production ? 240 : 2000,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'A few too many requests. Please try again in a moment.',
      },
    },
  }),
);
app.get('/api/health', (_req, res) => {
  const isReady = mongoose.connection.readyState === 1;
  return res.status(isReady ? 200 : 503).json({
    success: isReady,
    data: {
      status: isReady ? 'ready' : 'unavailable',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  });
});
app.use('/api/v1', api);
app.use('/api', () => {
  throw new ApiError(404, 'This API endpoint does not exist.', 'NOT_FOUND');
});
const frontend = resolve(projectRoot, 'frontend/dist');
if (existsSync(resolve(frontend, 'index.html'))) {
  app.use(express.static(frontend, { maxAge: env.production ? '1h' : 0 }));
  app.get('/{*path}', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(resolve(frontend, 'index.html'));
  });
}
app.use(errorHandler);
