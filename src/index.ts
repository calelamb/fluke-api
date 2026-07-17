import dotenv from 'dotenv';

dotenv.config();

const { env } = await import('./env.js');
const { buildApp } = await import('./app.js');
const { prisma } = await import('./db.js');

const app = await buildApp();
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shutdownStarted = false;

async function closeResources(): Promise<void> {
  try {
    await app.close();
  } finally {
    await prisma.$disconnect();
  }
}

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms`)),
      SHUTDOWN_TIMEOUT_MS,
    );
    timeout.unref();
  });

  app.log.info({ signal }, 'graceful shutdown started');
  try {
    await Promise.race([closeResources(), timeoutPromise]);
    app.log.info({ signal }, 'graceful shutdown completed');
    process.exitCode = 0;
  } catch (error) {
    app.log.error({ err: error, signal }, 'graceful shutdown failed');
    process.exit(1);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function handleSignal(signal: 'SIGINT' | 'SIGTERM'): void {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  void shutdown(signal);
}

process.once('SIGTERM', () => handleSignal('SIGTERM'));
process.once('SIGINT', () => handleSignal('SIGINT'));

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  await prisma.$disconnect();
  process.exit(1);
}
