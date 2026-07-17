import type { FastifyPluginAsync } from 'fastify';
import type {
  NotableEvent,
  SourceCitation,
  WhaleDTO,
  WhaleProfileDTO,
} from '../contracts/index.js';
import { prisma } from '../db.js';

function asNotableEvents(value: unknown): NotableEvent[] {
  return Array.isArray(value) ? (value as NotableEvent[]) : [];
}

function asSourceCitations(value: unknown): SourceCitation[] {
  return Array.isArray(value) ? (value as SourceCitation[]) : [];
}

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
  notableEvents: unknown;
  sourceCitations: unknown;
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
    notableEvents: asNotableEvents(whale.notableEvents).slice().sort((a, b) => a.year - b.year),
    sourceCitations: asSourceCitations(whale.sourceCitations),
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
      include: {
        mother: { select: { catalogId: true, name: true } },
        offspring: { select: { catalogId: true, name: true } },
        sightings: {
          where: { sighting: { status: 'APPROVED' } },
          take: 25,
          orderBy: { sighting: { observedAt: 'desc' } },
          include: {
            sighting: {
              select: {
                id: true,
                observedAt: true,
                locationName: true,
                latitude: true,
                longitude: true,
              },
            },
          },
        },
      },
    });

    if (!whale) {
      return reply.code(404).send({ error: 'Whale not found' });
    }

    const dto: WhaleProfileDTO = {
      ...toWhaleDTO(whale),
      mother: whale.mother,
      offspring: whale.offspring,
      recentSightings: whale.sightings.map(({ sighting }) => ({
        id: sighting.id,
        observedAt: sighting.observedAt.toISOString(),
        locationName: sighting.locationName,
        latitude: Number(sighting.latitude),
        longitude: Number(sighting.longitude),
      })),
    };

    return dto;
  });
};

export default whalesRoutes;
