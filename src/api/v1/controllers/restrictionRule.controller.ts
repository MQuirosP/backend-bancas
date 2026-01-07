import { Response } from "express";
import { AuthenticatedRequest } from "../../../core/types";
import { RestrictionRuleService } from "../services/restrictionRule.service";
import { applyRbacFilters, AuthContext, RequestFilters } from "../../../utils/rbac";
import prisma from "../../../core/prismaClient";
import logger from "../../../core/logger";

export const RestrictionRuleController = {
  async create(req: AuthenticatedRequest, res: Response) {
    const rule = await RestrictionRuleService.create(req.user!.id, req.body);
    res.status(201).json({ success: true, data: rule });
  },

  async update(req: AuthenticatedRequest, res: Response) {
    const rule = await RestrictionRuleService.update(
      req.user!.id,
      req.params.id,
      req.body
    );
    res.json({ success: true, data: rule });
  },

  async delete(req: AuthenticatedRequest, res: Response) {
    const rule = await RestrictionRuleService.remove(
      req.user!.id,
      req.params.id,
      req.body?.reason
    );
    res.json({ success: true, data: rule });
  },

  async restore(req: AuthenticatedRequest, res: Response) {
    const rule = await RestrictionRuleService.restore(
      req.user!.id,
      req.params.id
    );
    res.json({ success: true, data: rule });
  },

  async findById(req: AuthenticatedRequest, res: Response) {
    const rule = await RestrictionRuleService.getById(req.params.id);
    res.json({ success: true, data: rule });
  },

  async list(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;

    // Si es ADMIN con banca activa, agregar filtro de bancaId
    if (req.user!.role === 'ADMIN' && req.bancaContext?.bancaId && req.bancaContext.hasAccess) {
      query.bancaId = req.bancaContext.bancaId;
    }

    req.logger?.info({
      layer: "controller",
      action: "RESTRICTION_LIST_DEBUG",
      payload: { query, userIdParam: query.userId }
    });

    const result = await RestrictionRuleService.list(query);

    req.logger?.info({
      layer: "controller",
      action: "RESTRICTION_LIST_RESULT",
      payload: {
        count: result.data.length,
        sample: result.data[0] ? Object.keys(result.data[0]) : "empty"
      }
    });

    res.json({ success: true, data: result.data, meta: result.meta });
  },

  async getCronHealth(req: AuthenticatedRequest, res: Response) {
    const health = await RestrictionRuleService.getCronHealth();
    res.json({ success: true, data: health });
  },

  async executeCronManually(req: AuthenticatedRequest, res: Response) {
    const result = await RestrictionRuleService.executeCronManually();
    res.json({ success: true, data: result });
  },

  /**
   * GET /api/v1/restrictions/me
   * Obtiene restricciones del usuario autenticado o del vendedor especificado (impersonalización)
   * 
   *  NUEVO: Soporte para impersonalización con parámetro vendedorId
   * - Solo ADMIN y VENTANA pueden usar vendedorId
   * - VENDEDOR ignora vendedorId (comportamiento actual se mantiene)
   * - Validaciones de permisos mediante applyRbacFilters()
   */
  async myRestrictions(req: AuthenticatedRequest, res: Response) {
    const me = req.user!;
    const { vendedorId } = req.query as any;

    // Log para debugging
    req.logger?.info({
      layer: "controller",
      action: "RESTRICTIONS_ME_REQUEST",
      payload: {
        userId: me.id,
        role: me.role,
        requestedVendedorId: vendedorId,
      },
    });

    // Build auth context
    const context: AuthContext = {
      userId: me.id,
      role: me.role,
      ventanaId: me.ventanaId,
      bancaId: req.bancaContext?.bancaId || null,
    };

    //  NUEVO: Aplicar RBAC filters para validar permisos de vendedorId
    const requestFilters: RequestFilters = {
      ...(vendedorId ? { vendedorId } : {}),
    };

    const effectiveFilters = await applyRbacFilters(context, requestFilters);

    //  NUEVO: Determinar el vendedorId efectivo
    // Si hay vendedorId en effectiveFilters (y tiene permisos), usarlo
    // Si no, usar el userId del usuario autenticado (comportamiento actual)
    const effectiveVendorId = effectiveFilters.vendedorId || me.id;

    //  NUEVO: Obtener ventanaId y bancaId del vendedor seleccionado
    // Si estamos usando un vendedorId diferente, necesitamos su contexto
    let effectiveBancaId = req.bancaContext?.bancaId || null;
    let effectiveVentanaId = me.ventanaId || null;

    if (effectiveVendorId !== me.id) {
      // Estamos impersonalizando - obtener contexto del vendedor seleccionado
      try {
        const vendor = await prisma.user.findUnique({
          where: { id: effectiveVendorId },
          select: {
            ventanaId: true,
            ventana: {
              select: {
                bancaId: true,
              },
            },
          },
        });

        if (vendor) {
          effectiveVentanaId = vendor.ventanaId;
          effectiveBancaId = vendor.ventana?.bancaId || null;

          req.logger?.info({
            layer: "controller",
            action: "RESTRICTIONS_ME_IMPERSONATION",
            payload: {
              authenticatedUserId: me.id,
              effectiveVendorId,
              effectiveVentanaId,
              effectiveBancaId,
            },
          });
        } else {
          // Vendedor no encontrado (no debería pasar si applyRbacFilters funcionó correctamente)
          logger.warn({
            layer: "controller",
            action: "RESTRICTIONS_ME_VENDOR_NOT_FOUND",
            payload: {
              effectiveVendorId,
              authenticatedUserId: me.id,
            },
          });
        }
      } catch (error) {
        logger.error({
          layer: "controller",
          action: "RESTRICTIONS_ME_FETCH_VENDOR_ERROR",
          payload: {
            error: (error as Error).message,
            effectiveVendorId,
            authenticatedUserId: me.id,
          },
        });
        // Continuar con el contexto del usuario autenticado como fallback
      }
    }

    // If no bancaId is available, return empty restrictions
    if (!effectiveBancaId) {
      req.logger?.warn({
        layer: "controller",
        action: "RESTRICTIONS_ME_NO_BANCA_ID",
        payload: {
          effectiveVendorId,
          effectiveBancaId,
          effectiveVentanaId,
        },
      });

      return res.json({
        success: true,
        data: {
          general: [],
          vendorSpecific: []
        }
      });
    }

    //  MODIFICADO: Usar effectiveVendorId, effectiveBancaId, effectiveVentanaId
    const result = await RestrictionRuleService.forVendor(
      effectiveVendorId,
      effectiveBancaId,
      effectiveVentanaId
    );

    req.logger?.info({
      layer: "controller",
      action: "RESTRICTIONS_ME_RESULT",
      payload: {
        effectiveVendorId,
        generalCount: result.general.length,
        vendorSpecificCount: result.vendorSpecific.length,
        isImpersonating: effectiveVendorId !== me.id,
      },
    });

    res.json({ success: true, data: result });
  },
};
