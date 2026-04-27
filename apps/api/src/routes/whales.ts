import type { WhaleDTO } from '@fluke/shared';
import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';

function toWhaleDTO(whale: {
  id: string;
  catalogId: string;
  name: string | null;
  ecotype: WhaleDTO['ecotype'];
  pod: string | null;
  sex: WhaleDTO['sex'];
  birthYear: number | null;
  deathYear: number | null;
  status: WhaleDTO['status'];
  biography: string | null;
  distinguishingMarks: string | null;
  heroImageUrl: string | null;
}): WhaleDTO {
  return {
    id: whale.id,
    catalogId: whale.catalogId,
    name: whale.name,
    ecotype: whale.ecotype,
    pod: whale.pod,
    sex: whale.sex,
    birthYear: whale.birthYear,
    deathYear: whale.deathYear,
    status: whale.status,
    biography: whale.biography,
    distinguishingMarks: whale.distinguishingMarks,
    heroImageUrl: whale.heroImageUrl,
  };
}

const whalesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/whales', async (): Promise<WhaleDTO[]> => {
    const whales = await prisma.whale.findMany({
      take: 50,
      orderBy: { catalogId: 'asc' },
    });

    return whales.map(toWhaleDTO);
  });

  fastify.get<{ Params: { catalogId: string } }>('/whales/:catalogId', async (request, reply) => {
    const whale = await prisma.whale.findUnique({
      where: { catalogId: request.params.catalogId },
    });

    if (!whale) {
      return reply.notFound(`Whale ${request.params.catalogId} was not found`);
    }

    return toWhaleDTO(whale);
  });
};

export default whalesRoutes;
