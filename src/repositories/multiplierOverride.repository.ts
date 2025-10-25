// src/repositories/multiplierOverride.repository.ts
import { OverrideScope, Prisma } from "@prisma/client";
import prisma from "../core/prismaClient";
import { AppError } from "../core/errors";

export interface CreateMultiplierOverrideData {
  scope: OverrideScope;
  scopeId: string;
  loteriaId: string;
  multiplierType: string;
  baseMultiplierX: number;
}

export interface UpdateMultiplierOverrideData {
  baseMultiplierX?: number;
  isActive?: boolean;
}

export interface ListMultiplierOverrideFilters {
  scope?: OverrideScope;
  scopeId?: string;
  loteriaId?: string;
  multiplierType?: string;
  isActive?: boolean;
  page?: number;
  pageSize?: number;
}

export const MultiplierOverrideRepository = {
  /**
   * Create a new multiplier override
   * Maps scope/scopeId to userId or ventanaId based on scope type
   */
  async create(data: CreateMultiplierOverrideData) {
    const { scope, scopeId, loteriaId, multiplierType, baseMultiplierX } = data;

    // Validation: baseMultiplierX must be positive
    if (baseMultiplierX <= 0) {
      throw new AppError("baseMultiplierX must be greater than 0", 400);
    }

    // Map scope and scopeId to the appropriate fields
    const userId = scope === OverrideScope.USER ? scopeId : null;
    const ventanaId = scope === OverrideScope.VENTANA ? scopeId : null;

    try {
      return await prisma.multiplierOverride.create({
        data: {
          scope,
          userId,
          ventanaId,
          loteriaId,
          multiplierType,
          baseMultiplierX,
          isActive: true,
        },
        include: {
          user: true,
          ventana: true,
          loteria: true,
        },
      });
    } catch (error: any) {
      // Handle unique constraint violation (P2002)
      if (error.code === "P2002") {
        throw new AppError(
          `A multiplier override already exists for this ${scope.toLowerCase()}, loteria, and multiplier type`,
          409,
          { meta: error.meta }
        );
      }
      throw error;
    }
  },

  /**
   * Update an existing multiplier override
   */
  async update(id: string, data: UpdateMultiplierOverrideData) {
    // Validation: if baseMultiplierX is provided, it must be positive
    if (data.baseMultiplierX !== undefined && data.baseMultiplierX <= 0) {
      throw new AppError("baseMultiplierX must be greater than 0", 400);
    }

    try {
      return await prisma.multiplierOverride.update({
        where: { id },
        data,
        include: {
          user: true,
          ventana: true,
          loteria: true,
        },
      });
    } catch (error: any) {
      if (error.code === "P2025") {
        throw new AppError("Multiplier override not found", 404);
      }
      throw error;
    }
  },

  /**
   * Soft delete (set isActive = false, deletedAt = now)
   */
  async softDelete(id: string, deletedBy?: string, deletedReason?: string) {
    try {
      return await prisma.multiplierOverride.update({
        where: { id },
        data: {
          isActive: false,
          deletedAt: new Date(),
          deletedBy,
          deletedReason,
        },
        include: {
          user: true,
          ventana: true,
          loteria: true,
        },
      });
    } catch (error: any) {
      if (error.code === "P2025") {
        throw new AppError("Multiplier override not found", 404);
      }
      throw error;
    }
  },

  /**
   * Restore (set isActive = true, deletedAt = null)
   */
  async restore(id: string) {
    try {
      return await prisma.multiplierOverride.update({
        where: { id },
        data: {
          isActive: true,
          deletedAt: null,
          deletedBy: null,
          deletedReason: null,
        },
        include: {
          user: true,
          ventana: true,
          loteria: true,
        },
      });
    } catch (error: any) {
      if (error.code === "P2025") {
        throw new AppError("Multiplier override not found", 404);
      }
      throw error;
    }
  },

  /**
   * Get a single override by ID
   */
  async getById(id: string) {
    return await prisma.multiplierOverride.findUnique({
      where: { id },
      include: {
        user: true,
        ventana: true,
        loteria: true,
      },
    });
  },

  /**
   * Find one override matching specific criteria
   * Used for multiplier resolution during ticket creation
   */
  async findOne(filters: {
    scope: OverrideScope;
    scopeId: string;
    loteriaId: string;
    multiplierType: string;
    isActive?: boolean;
  }) {
    const { scope, scopeId, loteriaId, multiplierType, isActive = true } = filters;

    const userId = scope === OverrideScope.USER ? scopeId : null;
    const ventanaId = scope === OverrideScope.VENTANA ? scopeId : null;

    return await prisma.multiplierOverride.findFirst({
      where: {
        scope,
        userId,
        ventanaId,
        loteriaId,
        multiplierType,
        isActive,
      },
      include: {
        user: true,
        ventana: true,
        loteria: true,
      },
    });
  },

  /**
   * List overrides with filters and pagination
   */
  async list(filters: ListMultiplierOverrideFilters) {
    const {
      scope,
      scopeId,
      loteriaId,
      multiplierType,
      isActive,
      page = 1,
      pageSize = 10,
    } = filters;

    const where: Prisma.MultiplierOverrideWhereInput = {};

    if (scope !== undefined) {
      where.scope = scope;
    }

    if (scopeId !== undefined) {
      if (scope === OverrideScope.USER) {
        where.userId = scopeId;
      } else if (scope === OverrideScope.VENTANA) {
        where.ventanaId = scopeId;
      } else {
        // If scope is not provided but scopeId is, search in both
        where.OR = [{ userId: scopeId }, { ventanaId: scopeId }];
      }
    }

    if (loteriaId !== undefined) {
      where.loteriaId = loteriaId;
    }

    if (multiplierType !== undefined) {
      where.multiplierType = multiplierType;
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const skip = (page - 1) * pageSize;

    const [data, total] = await Promise.all([
      prisma.multiplierOverride.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          user: true,
          ventana: true,
          loteria: true,
        },
      }),
      prisma.multiplierOverride.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      pageSize,
      pages: Math.ceil(total / pageSize),
    };
  },

  /**
   * Check if an override exists for the given criteria
   */
  async exists(filters: {
    scope: OverrideScope;
    scopeId: string;
    loteriaId: string;
    multiplierType: string;
  }): Promise<boolean> {
    const { scope, scopeId, loteriaId, multiplierType } = filters;

    const userId = scope === OverrideScope.USER ? scopeId : null;
    const ventanaId = scope === OverrideScope.VENTANA ? scopeId : null;

    const count = await prisma.multiplierOverride.count({
      where: {
        scope,
        userId,
        ventanaId,
        loteriaId,
        multiplierType,
        isActive: true,
      },
    });

    return count > 0;
  },
};

export default MultiplierOverrideRepository;
