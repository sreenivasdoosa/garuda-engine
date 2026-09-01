/**
 * Exchange Service
 * API service for exchange configuration management
 */

import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type {
  Exchange,
  CreateExchangeRequest,
  UpdateExchangeRequest,
  Holiday,
  CreateHolidayRequest,
  UpdateHolidayRequest,
  EventDay,
  CreateEventDayRequest,
  ExchangeOptions,
} from '@/types/exchange';

// ==================== EXCHANGES ====================

export const exchangeService = {
  // Get all exchanges
  async getAll(): Promise<Exchange[]> {
    return api.get<Exchange[]>(API_ENDPOINTS.EXCHANGES.LIST);
  },

  // What the venue form may choose from — the engine's own enums.
  async getOptions(): Promise<ExchangeOptions> {
    return api.get<ExchangeOptions>(API_ENDPOINTS.EXCHANGES.OPTIONS);
  },

  // Get exchange by code
  async getByCode(code: string): Promise<Exchange> {
    return api.get<Exchange>(API_ENDPOINTS.EXCHANGES.DETAILS(code));
  },

  // Create new exchange
  async create(request: CreateExchangeRequest): Promise<Exchange> {
    return api.post<Exchange>(API_ENDPOINTS.EXCHANGES.BASE, request);
  },

  // Update exchange
  async update(code: string, request: UpdateExchangeRequest): Promise<Exchange> {
    return api.put<Exchange>(API_ENDPOINTS.EXCHANGES.DETAILS(code), request);
  },

  // Delete exchange
  async delete(code: string): Promise<void> {
    return api.delete(API_ENDPOINTS.EXCHANGES.DETAILS(code));
  },


};

// ==================== HOLIDAYS ====================

export const holidayService = {
  // Get holidays by exchange
  async getByExchange(exchange: string): Promise<Holiday[]> {
    return api.get<Holiday[]>(API_ENDPOINTS.HOLIDAYS.BY_EXCHANGE(exchange));
  },

  // Create holiday
  async create(request: CreateHolidayRequest): Promise<Holiday> {
    return api.post<Holiday>(API_ENDPOINTS.HOLIDAYS.BASE, request);
  },

  // Update holiday
  async update(exchange: string, date: string, request: UpdateHolidayRequest): Promise<Holiday> {
    return api.put<Holiday>(API_ENDPOINTS.HOLIDAYS.DELETE(exchange, date), request);
  },

  // Delete holiday
  async delete(exchange: string, date: string): Promise<void> {
    return api.delete(API_ENDPOINTS.HOLIDAYS.DELETE(exchange, date));
  },
};

// ==================== EVENT DAYS ====================

export const eventDayService = {
  // Get event days by exchange
  async getByExchange(exchange: string): Promise<EventDay[]> {
    return api.get<EventDay[]>(API_ENDPOINTS.EVENT_DAYS.BY_EXCHANGE(exchange));
  },

  // Create event day
  async create(request: CreateEventDayRequest): Promise<EventDay> {
    return api.post<EventDay>(API_ENDPOINTS.EVENT_DAYS.BY_EXCHANGE(request.exchange), request);
  },

  // Update event day
  async update(exchange: string, eventDate: string, request: Partial<CreateEventDayRequest>): Promise<EventDay> {
    return api.put<EventDay>(API_ENDPOINTS.EVENT_DAYS.DETAILS(exchange, eventDate), request);
  },

  // Delete event day
  async delete(exchange: string, eventDate: string): Promise<void> {
    return api.delete(API_ENDPOINTS.EVENT_DAYS.DETAILS(exchange, eventDate));
  },
};
