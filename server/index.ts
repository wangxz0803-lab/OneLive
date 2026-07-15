import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIoServer } from 'socket.io';
import { createServer as createViteServer, loadEnv, type ViteDevServer } from 'vite';
import type {
  ClientToServerEvents,
  IceServerConfig,
  InterServerEvents,
  RuntimeConfig,
  ServerToClientEvents,
  SocketData,
} from '../src/realtime/protocol';
import { SESSION_ID_PATTERN } from '../src/realtime/protocol';
import { installSignaling } from './signaling';
import { findLanAddresses, loadOrCreateCertificate } from './tls';
import { installTranslationRoute } from './translation';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const production = process.env.NODE_ENV === 'production';
const environment = {
  ...loadEnv(production ? 'production' : 'development', rootDirectory, ''),
  ...process.env,
};
const mockMode = environment.DEMO_MOCK === 'true';
const secure = environment.DEMO_HTTPS === 'true';
const parsedPort = Number.parseInt(environment.PORT ?? '5173', 10);
const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 5173;
const sessionId = SESSION_ID_PATTERN.test(environment.DEMO_SESSION_ID ?? '')
  ? (environment.DEMO_SESSION_ID as string)
  : 'ONE-DEMO';
const socketPath = '/socket.io';
const lanAddresses = findLanAddresses();
const aiApiUrl = environment.AI_API_URL?.trim();
const aiApiKey = environment.AI_API_KEY?.trim();
const aiModel = environment.AI_MODEL?.trim() || 'gpt-4o-mini';

const parseIceServers = (): IceServerConfig[] => {
  const raw = environment.ICE_SERVERS_JSON?.trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is IceServerConfig => {
      if (!entry || typeof entry !== 'object') return false;
      const urls = (entry as { urls?: unknown }).urls;
      return (
        typeof urls === 'string' ||
        (Array.isArray(urls) && urls.length > 0 && urls.every((url) => typeof url === 'string'))
      );
    });
  } catch {
    console.warn('[OneLive] ICE_SERVERS_JSON is invalid; continuing with LAN host candidates.');
    return [];
  }
};

const start = async (): Promise<void> => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  const iceServers = parseIceServers();
  const runtimeConfig: RuntimeConfig = {
    mode: mockMode ? 'mock' : 'live',
    secure,
    sessionId,
    socketPath,
    iceServers,
    translation: {
      available: Boolean(aiApiUrl && aiApiKey),
      ...(aiApiUrl && aiApiKey ? { model: aiModel } : {}),
    },
    paths: {
      control: `/?session=${encodeURIComponent(sessionId)}`,
      broadcaster: `/broadcast/${encodeURIComponent(sessionId)}`,
    },
  };

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, service: 'onelive', mode: runtimeConfig.mode });
  });
  app.get('/api/config', (_request, response) => {
    response.set('cache-control', 'no-store').json(runtimeConfig);
  });
  installTranslationRoute(app, {
    apiUrl: aiApiUrl,
    apiKey: aiApiKey,
    model: aiModel,
  });

  const tlsOptions = secure
    ? await loadOrCreateCertificate(rootDirectory, lanAddresses)
    : undefined;
  const httpServer = tlsOptions
    ? createHttpsServer(tlsOptions, app)
    : createHttpServer(app);

  const io = new SocketIoServer<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    path: socketPath,
    serveClient: false,
    maxHttpBufferSize: 256_000,
    pingInterval: 10_000,
    pingTimeout: 8_000,
  });
  const disposeSignaling = installSignaling(io);

  let vite: ViteDevServer | undefined;
  if (!production) {
    vite = await createViteServer({
      root: rootDirectory,
      appType: 'spa',
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
      },
    });
    app.use(vite.middlewares);
  } else {
    const distributionDirectory = path.join(rootDirectory, 'dist');
    app.use(express.static(distributionDirectory, { index: false }));
    app.use((request, response, next) => {
      if (request.method !== 'GET' || request.path.startsWith('/api/')) {
        next();
        return;
      }
      response.sendFile(path.join(distributionDirectory, 'index.html'), (error) => {
        if (error && !response.headersSent) {
          response.status(503).json({
            code: 'DEMO_BUILD_MISSING',
            message: 'The OneLive web build is unavailable. Run npm run build before starting demo mode.',
          });
        }
      });
    });
  }

  app.use((request, response) => {
    response.status(404).json({
      code: 'NOT_FOUND',
      message: `No OneLive endpoint exists at ${request.path}.`,
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '0.0.0.0', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const protocol = secure ? 'https' : 'http';
  console.log('');
  console.log('  OneLive realtime demo is ready');
  console.log(`  Desktop: ${protocol}://localhost:${port}${runtimeConfig.paths.control}`);
  if (lanAddresses.length === 0) {
    console.log(`  Phone:   ${protocol}://<LAN-IP>:${port}${runtimeConfig.paths.broadcaster}`);
  } else {
    for (const address of lanAddresses) {
      console.log(`  Phone:   ${protocol}://${address}:${port}${runtimeConfig.paths.broadcaster}`);
    }
  }
  if (secure) {
    console.log('  HTTPS:   local self-signed certificate (accept it once on the phone)');
  }
  console.log('');

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    disposeSignaling();
    io.close();
    await vite?.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
};

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  console.error(`[OneLive] Server startup failed: ${message}`);
  process.exitCode = 1;
});
