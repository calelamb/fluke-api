import dotenv from 'dotenv';

dotenv.config();

const { env } = await import('./env.js');
const { buildApp } = await import('./app.js');

const app = await buildApp();

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
