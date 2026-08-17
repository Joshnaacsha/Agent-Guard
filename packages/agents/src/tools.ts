import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { searchSimilarIncidents } from '@agentguard/db';
import { generateEmbedding } from './embeddings/pipeline';

export interface SimilarIncidentMatch {
  summary: string;
  resolution: string;
  distance: number;
}

const searchSimilarIncidentsSchema = z.object({
  query: z.string().describe('A description of the current pod failure symptoms to search for'),
  limit: z.number().int().positive().max(10).optional().describe('Max number of similar incidents to return (default 3)'),
});

interface SearchSimilarIncidentsArgs {
  query: string;
  limit?: number;
}

async function searchSimilarIncidentsImpl(args: SearchSimilarIncidentsArgs): Promise<string> {
  const { query, limit } = args;
  const embedding = await generateEmbedding(query);
  const matches = await searchSimilarIncidents(embedding, limit ?? 3);
  const result: SimilarIncidentMatch[] = matches.map((m) => ({
    summary: m.summary,
    resolution: m.resolution,
    distance: m.distance,
  }));
  return JSON.stringify(result);
}

// `schema` is cast to `any` here — with this project's TS/zod/@langchain-core combination,
// letting DynamicStructuredTool infer its generic from a zod ZodObject blows up with
// TS2589 (excessively deep instantiation). `func`'s own parameter type is already explicit
// via SearchSimilarIncidentsArgs, so this loses nothing but the (redundant) inference.
export const searchSimilarIncidentsTool = new DynamicStructuredTool({
  name: 'search_similar_incidents',
  description:
    'Search the shared incident_memory vector store for past resolved Kubernetes pod ' +
    'incidents whose symptoms are similar to the current one. Returns summary, resolution, ' +
    'and vector distance (lower = more similar), nearest first.',
  schema: searchSimilarIncidentsSchema as any,
  func: searchSimilarIncidentsImpl,
});

export async function findSimilarIncidents(query: string, limit = 3): Promise<SimilarIncidentMatch[]> {
  const raw = await searchSimilarIncidentsTool.invoke({ query, limit });
  return JSON.parse(raw as string) as SimilarIncidentMatch[];
}
