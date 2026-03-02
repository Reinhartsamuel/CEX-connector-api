import { z } from 'zod';


export const dashboardQuerySchema = z.object({
  period: z.string().toLowerCase().pipe(z.enum(['7d', '30d', '90d', 'all'])).default('7d'),
});


export const tradesQuerySchema = z.object({
  exchange_id: z.coerce.number().int().positive().optional(),
  market_type: z.string().optional(),
  contract: z.string().optional(),
  position_type: z.enum(['long', 'short']).optional(),
  status: z.string().optional(),
  date_from: z.iso.datetime().optional(),
  date_to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});


export const accountsQuerySchema = z.object({
  market_type: z.string().optional(),
  exchange_title: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});


export const loginSchema = z.object({
  idToken: z.string().min(1),
});