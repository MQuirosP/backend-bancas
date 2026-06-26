import { Request, Response, NextFunction } from "express";

export function requireJson(req: Request, res: Response, next: NextFunction) {
  // Solo para métodos que llevan cuerpo
  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    const contentLength = req.headers["content-length"];
    const transferEncoding = req.headers["transfer-encoding"];

    // Si no hay cuerpo, no exigimos Content-Type
    if (!transferEncoding && (contentLength === undefined || contentLength === "0")) {
      return next();
    }

    const ct = req.headers["content-type"] || "";
    if (!String(ct).includes("application/json")) {
      return res.status(415).json({ success: false, error: "Unsupported Media Type" });
    }
  }
  next();
}
