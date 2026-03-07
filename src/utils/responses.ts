import { Response } from 'express';

export const success = (res: Response, data: any, meta?: any) => {
  if (res.headersSent) return;
  return res.status(200).json({
    success: true,
    data,
    ...(meta ? { meta } : {}),
  });
};

export const created = (res: Response, data: any) => {
  if (res.headersSent) return;
  return res.status(201).json({
    success: true,
    data,
  });
};

export const noContent = (res: Response) => {
  if (res.headersSent) return;
  return res.status(204).send();
};

export const error = (res: Response, message: string, status = 500, meta?: any) => {
  if (res.headersSent) return;
  return res.status(status).json({
    success: false,
    message,
    ...(meta ? { meta } : {}),
  });
};
