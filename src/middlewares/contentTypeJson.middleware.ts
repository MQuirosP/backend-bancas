import { Request, Response, NextFunction } from "express";

export function requireJson(req: Request, res: Response, next: NextFunction) {
  // Solo para métodos que llevan cuerpo
  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    const ct = req.headers["content-type"] || "";
    if (!String(ct).includes("application/json")) {
      return res.status(415).json({ success: false, error: "Unsupported Media Type" });
    }
  }
  next();
}
