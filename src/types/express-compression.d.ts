declare module "express-compression" {
  import { RequestHandler } from "express";
  export interface CompressionOptions {
    filter?: (req: any, res: any) => boolean;
    threshold?: number | string;
    level?: number;
    chunkSize?: number;
    memLevel?: number;
    strategy?: number;
    brotli?: {
      enabled?: boolean;
      zlib?: Record<string, unknown>;
    };
    cacheSize?: number;
  }
  export default function compression(options?: CompressionOptions): RequestHandler;
}
