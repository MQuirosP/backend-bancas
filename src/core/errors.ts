export class AppError extends Error {
    public statusCode: number;
    public isOperational: boolean;
    public meta?: any;

    constructor(message: string, statusCode: number, meta?: any) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true;
        this.meta = meta;
        Object.setPrototypeOf(this, new.target.prototype); // restore prototype chain
        Error.captureStackTrace(this, this.constructor);
    }
}