import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import type { IdentifyResponseDTO } from '../contracts/index.js';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { buildPhotoFilename, getStorageBackend } from '../lib/storage.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface IdentifierServiceResponse {
  matches: IdentifyResponseDTO['matches'];
  confidenceBand: IdentifyResponseDTO['confidenceBand'];
  model: string;
  indexVersion: string;
}

const identifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/identify', async (request, reply): Promise<IdentifyResponseDTO | void> => {
    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'Multipart file required' });
    }
    if (!ACCEPTED_MIME.has(file.mimetype)) {
      return reply.code(415).send({ error: `Unsupported content type: ${file.mimetype}` });
    }

    const buffer = await file.toBuffer();
    if (buffer.byteLength === 0) {
      return reply.code(400).send({ error: 'Empty file' });
    }
    if (buffer.byteLength > MAX_FILE_BYTES) {
      return reply.code(413).send({ error: `File exceeds ${MAX_FILE_BYTES} bytes.` });
    }

    const storage = getStorageBackend();
    const filename = buildPhotoFilename(file.filename || 'identify-upload.jpg', buffer);
    const stored = await storage.put({
      prefix: 'identify-uploads',
      filename,
      contentType: file.mimetype,
      body: buffer,
    });

    const serviceUrl = `${env.IDENTIFIER_SERVICE_URL.replace(/\/$/, '')}/identify-json`;
    let serviceResponse: globalThis.Response;
    try {
      serviceResponse = await fetch(serviceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_base64: buffer.toString('base64'),
          filename: file.filename || filename,
          content_type: file.mimetype,
        }),
      });
    } catch (error) {
      request.log.error({ error, serviceUrl }, 'identifier service unavailable');
      return reply.code(503).send({ error: 'Identifier service is not running' });
    }

    if (!serviceResponse.ok) {
      const text = await serviceResponse.text();
      request.log.error(
        { status: serviceResponse.status, body: text.slice(0, 500) },
        'identifier service failed',
      );
      return reply.code(502).send({ error: 'Identifier service failed' });
    }

    const result = (await serviceResponse.json()) as IdentifierServiceResponse;
    const response: IdentifyResponseDTO = {
      ...result,
      uploadUrl: storage.publicUrl(stored.key),
    };

    await prisma.identificationAttempt.create({
      data: {
        uploadKey: stored.key,
        uploadUrl: storage.publicUrl(stored.key),
        resultJson: response as unknown as Prisma.InputJsonValue,
      },
    });

    return response;
  });
};

export default identifyRoutes;
