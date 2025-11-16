import { Request } from "express";
import { Role } from "@prisma/client";

export interface AuthUser {
    id: string;
    role: Role;
    ventanaId?: string | null;
    bancaId?: string | null;
}

export interface BancaContext {
  bancaId: string | null;
  userId: string;
  hasAccess: boolean;
}

export interface RequestWithUser extends Request {
    user?: AuthUser;
    requestId?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  bancaContext?: BancaContext;
  requestId?: string;
}
