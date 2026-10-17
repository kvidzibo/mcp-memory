import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max)
  .refine(value => Buffer.byteLength(value,'utf8') <= max, `Must not exceed ${max} UTF-8 bytes`)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value), 'Control characters are not allowed');
export const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const evidenceSchema = z.strictObject({ description: text(1000), source_uri: text(2048).optional() });
export const contentShape = {
  text: text(2000),
  evidence: z.array(evidenceSchema).min(1).max(5),
  reason: text(1000).optional(),
};
export const addSchema = z.strictObject({ ...contentShape, scope: z.enum(['project','global']).default('project') });
export const supersedeSchema = z.strictObject({ ...contentShape, id: idSchema });
export const archiveSchema = z.strictObject({ id: idSchema, reason: text(1000).optional() });
export const searchSchema = z.strictObject({
  query: text(1000), limit: z.number().int().min(1).max(50).default(5),
  scope: z.enum(['project','global','all']).default('all'),
});
export const getSchema = z.strictObject({ id: idSchema });
export const feedbackSchema = z.strictObject({
  memory_id: idSchema,
  verdict: z.enum(['useful','not_useful','incorrect','outdated']),
  reason: text(1000).optional(),
});
export type AddInput = z.infer<typeof addSchema>;
export type SupersedeInput = z.infer<typeof supersedeSchema>;
export type SearchInput = z.infer<typeof searchSchema>;
export type FeedbackInput = z.infer<typeof feedbackSchema>;
export interface Origin { client: string; session: string | null; model: string | null }
export interface StoreOptions {
  database: string; project: string; origin: Origin;
  allowWrite: boolean; allowGlobalWrite: boolean; readGlobal: boolean;
}
export interface Evidence { id: number; memory_id: number; description: string; source_uri: string | null; created_at: number }
export interface Memory {
  id: number; scope_id: number; scope: 'project' | 'global'; text: string; text_hash: string;
  status: 'active' | 'archived'; supersedes_id: number | null;
  source_client: string; source_session: string | null; source_model: string | null;
  created_at: number; archived_at: number | null; evidence: Evidence[];
}
export interface Statistics {
  retrieval_count: number; useful_count: number; not_useful_count: number;
  incorrect_count: number; outdated_count: number;
  last_retrieved_at: number | null; last_feedback_at: number | null;
}
export class InputError extends Error {}
