import { Request, Response, NextFunction } from 'express';
import { protectOpsHardened } from '../../src/middlewares/opsAuth.middleware';
import { config } from '../../src/config';

describe('Security: protectOpsHardened middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let nextFn: jest.Mock;

  const validSecret = 'test-super-secret-key-that-has-more-than-32-chars-entropy';

  beforeEach(() => {
    config.ops.secret = validSecret;
    config.ops.allowedIps = [];

    mockReq = {
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' } as any,
      headers: {},
      originalUrl: '/api/v1/ops/vendor/search',
      method: 'POST'
    };

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };

    nextFn = jest.fn();
  });

  it('debe rechazar con 403 Forbidden si la petición proviene de una IP externa no autorizada', () => {
    mockReq.ip = '198.51.100.42';
    mockReq.socket = { remoteAddress: '10.0.0.1' } as any;

    protectOpsHardened(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('Acceso denegado')
      })
    );
    expect(nextFn).not.toHaveBeenCalled();
  });

  it('debe permitir el acceso si la IP externa está en OPS_ALLOWED_IPS', () => {
    config.ops.allowedIps = ['198.51.100.42'];
    mockReq.ip = '198.51.100.42';
    mockReq.socket = { remoteAddress: '10.0.0.1' } as any;
    mockReq.headers = { 'x-ops-secret': validSecret };

    protectOpsHardened(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).toHaveBeenCalled();
  });

  it('debe responder 503 Fail-Closed si OPS_SECRET no está configurado', () => {
    config.ops.secret = undefined;
    mockReq.headers = { 'x-ops-secret': 'cualquier-clave' };

    protectOpsHardened(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(503);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('deshabilitadas')
      })
    );
    expect(nextFn).not.toHaveBeenCalled();
  });

  it('debe responder 401 si falta la cabecera x-ops-secret', () => {
    mockReq.headers = {};

    protectOpsHardened(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('credencial X-Ops-Secret requerida')
      })
    );
    expect(nextFn).not.toHaveBeenCalled();
  });

  it('debe responder 401 si el secreto provisto es incorrecto', () => {
    mockReq.headers = { 'x-ops-secret': 'clave-invalida-incorrecta' };

    protectOpsHardened(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('Acceso no autorizado')
      })
    );
    expect(nextFn).not.toHaveBeenCalled();
  });

  it('debe llamar a next() si la IP es loopback y el secreto coincide exactamente', () => {
    mockReq.headers = { 'x-ops-secret': validSecret };

    protectOpsHardened(mockReq as Request, mockRes as Response, nextFn);

    expect(nextFn).toHaveBeenCalledTimes(1);
    expect(mockRes.status).not.toHaveBeenCalled();
  });
});

