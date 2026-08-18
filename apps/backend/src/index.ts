import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '..', '..', '..', '.env') });

import express from 'express';
import cors from 'cors';
import { router } from './api/routes';

const app = express();
const PORT = process.env.PORT ?? 3001;

// CORS_ORIGIN: comma-separated allowed origins (e.g. the Vercel frontend URL).
// Falls back to allow-all so local dev and unconfigured deploys keep working.
const allowedOrigins = process.env.CORS_ORIGIN?.split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors(allowedOrigins?.length ? { origin: allowedOrigins } : undefined));
app.use(express.json());
app.use('/api', router);

app.listen(PORT, () => {
  console.log(`AgentGuard backend running on http://localhost:${PORT}`);
});
