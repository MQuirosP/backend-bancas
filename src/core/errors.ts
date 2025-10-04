export class AppError extends Error {
    public statusCode: number;
    public isOperational: boolean;
    public meta?: any;
    constructor(message: string, statusCode: number, isOperational = true, meta?: any) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        this.meta = meta;
        Error.captureStackTrace(this, this.constructor);
    }
}