import { config } from "../../config";
import { AppError } from "../../core/errors";
import logger from "../../core/logger";

export interface PartnerComboDto {
  id: string;
  name: string;
  description: string | null;
  price: number;
  passQuantity: number;
  fichaQuantity: number;
  badgeLabel: string | null;
}

export interface PartnerCampaignDto {
  id: string;
  slug: string;
  title: string;
  drawAt: string;
  drawReference: string | null;
  totalFichas: number;
  digits: number;
  enableInverseNumbers: boolean;
  remainingFichas: number;
  combos: PartnerComboDto[];
}

export interface CreatePartnerOrderPayload {
  campaignId: string;
  comboId: string;
  customer: {
    fullName: string;
    phone: string;
    email?: string;
  };
  selectionMode?: "RANDOM" | "MANUAL";
  selectedNumbers?: string[];
  includeInverse?: boolean;
  idempotencyKey: string;
  externalContext: {
    bancaId: string;
    ventanaId: string;
    sellerId: string;
    sellerName: string;
  };
}

export interface PartnerOrderResponseDto {
  orderId: string;
  publicReference: string;
  accessToken: string;
  trackingUrl: string;
  campaign: {
    id: string;
    title: string;
    drawAt: string;
    totalFichas: number;
    digits: number;
  };
  combo: {
    id: string;
    name: string;
    totalAmount: number;
  };
  numbers: string[];
  confirmedAt: string;
}

export interface CancelPartnerOrderPayload {
  reason?: string;
  cancelledById?: string;
}

export interface CancelPartnerOrderResponseDto {
  orderId: string;
  publicReference: string;
  status: "CANCELLED";
}

const REQUEST_TIMEOUT_MS = 10_000;

export class PremiaticoClient {
  private static getConfig(): { apiUrl: string; partnerId: string; partnerKey: string } {
    const apiUrl = config.premiatico?.apiUrl?.replace(/\/+$/, "");
    const partnerId = config.premiatico?.partnerId;
    const partnerKey = config.premiatico?.partnerKey;

    if (!apiUrl || !partnerId || !partnerKey) {
      throw new AppError(
        "Integración con Premiático no configurada en el servidor",
        503,
        "PREMIATICO_NOT_CONFIGURED",
      );
    }

    return { apiUrl, partnerId, partnerKey };
  }

  private static async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { apiUrl, partnerId, partnerKey } = this.getConfig();
    const url = `${apiUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Partner-Id": partnerId,
          "X-Partner-Key": partnerKey,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: any) {
      const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
      logger.error({
        layer: "integration",
        action: "PREMIATICO_HTTP_ERROR",
        payload: { method, path, error: err?.message, isTimeout },
      });
      throw new AppError(
        isTimeout
          ? "Tiempo de espera agotado al conectar con Premiático"
          : "No se pudo conectar con el servicio de Premiático",
        isTimeout ? 504 : 502,
        isTimeout ? "PREMIATICO_TIMEOUT" : "PREMIATICO_UNAVAILABLE",
      );
    }

    let json: any = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (!response.ok || !json?.success) {
      const upstreamMessage =
        json?.error?.message ||
        json?.message ||
        `Error HTTP ${response.status} desde Premiático`;
      const upstreamCode = json?.error?.code || "PREMIATICO_ERROR";

      logger.warn({
        layer: "integration",
        action: "PREMIATICO_API_REJECTED",
        payload: {
          method,
          path,
          status: response.status,
          code: upstreamCode,
          message: upstreamMessage,
        },
      });

      const mappedStatus =
        response.status >= 400 && response.status < 500 ? response.status : 502;
      throw new AppError(upstreamMessage, mappedStatus, upstreamCode);
    }

    return json.data as T;
  }

  static async getCampaigns(): Promise<PartnerCampaignDto[]> {
    return this.request<PartnerCampaignDto[]>("GET", "/api/v1/partner/campaigns");
  }

  static async createOrder(
    payload: CreatePartnerOrderPayload,
  ): Promise<PartnerOrderResponseDto> {
    return this.request<PartnerOrderResponseDto>(
      "POST",
      "/api/v1/partner/orders",
      payload,
    );
  }

  static async cancelOrder(
    publicReference: string,
    payload: CancelPartnerOrderPayload = {},
  ): Promise<CancelPartnerOrderResponseDto> {
    return this.request<CancelPartnerOrderResponseDto>(
      "POST",
      `/api/v1/partner/orders/${encodeURIComponent(publicReference)}/cancel`,
      payload,
    );
  }
}
