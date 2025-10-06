import { Request } from "express";
import { Role } from "@prisma/client";

export interface AuthUser {
    id: string;
    role: Role;
    ventanaId?: string | null;
}

export interface RequestWithUser extends Request {
    user?: AuthUser;
    requestId?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}
