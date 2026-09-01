/**
 * Stock Universe (watchlist) Service — equity only.
 * API service for stock universes backing equity strategies.
 * Backed by StockUniverseServletV2 at /api/v2/engine/universes.
 */

import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { StockUniverse, CreateStockUniverseRequest, UpdateStockUniverseRequest } from '@/types/stock-universe';

export const stockUniverseService = {
  // Get all universes (predefined NSE index + custom lists)
  async getAll(): Promise<StockUniverse[]> {
    return api.get<StockUniverse[]>(API_ENDPOINTS.V2_ENGINE_UNIVERSES.LIST);
  },

  // Get active universes only
  async getActive(): Promise<StockUniverse[]> {
    return api.get<StockUniverse[]>(API_ENDPOINTS.V2_ENGINE_UNIVERSES.ACTIVE);
  },

  // Get universe by id (header + members)
  async getById(universeId: number): Promise<StockUniverse> {
    return api.get<StockUniverse>(API_ENDPOINTS.V2_ENGINE_UNIVERSES.DETAILS(universeId));
  },

  // Create a custom universe (optionally with members)
  async create(data: CreateStockUniverseRequest): Promise<StockUniverse> {
    return api.post<StockUniverse>(API_ENDPOINTS.V2_ENGINE_UNIVERSES.BASE, data);
  },

  // Update universe header (and replace members if provided)
  async update(universeId: number, data: UpdateStockUniverseRequest): Promise<StockUniverse> {
    return api.put<StockUniverse>(API_ENDPOINTS.V2_ENGINE_UNIVERSES.DETAILS(universeId), data);
  },

  // Delete universe
  async delete(universeId: number): Promise<void> {
    return api.delete(API_ENDPOINTS.V2_ENGINE_UNIVERSES.DETAILS(universeId));
  },
};

export default stockUniverseService;
