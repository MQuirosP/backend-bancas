import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";

/** Añade X-Request_id si no existe y lo coloca en req.requestId y en la  
 * respuesta.
 * Para TS strict usamos cast local y no tocamos global augmentation aquí.  
 */

export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const existing = req.header('X-Request-Id');
    const id = existing ?? uuidv4();
    res.setHeader('X-Request-Id', id);
    (req as any).requestId = id;
    next();
}