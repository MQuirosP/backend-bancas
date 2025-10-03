import * as dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import authRoutes from './routes/auth.routes';
import ticketRoutes from './routes/ticket.routes';
import userRoutes from './routes/user.routes';
import lotteryRoutes from './routes/lottery.routes';
import closureRoutes from './routes/closure.routes';
import reportRoutes from './routes/report.routes'; // <-- IMPORTADO

// Inicializa Prisma Client (Conexión a Supabase)
const prisma = new PrismaClient();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Routes
app.get('/', (req: Request, res: Response) => {
    res.status(200).json({ status: 'API is running', environment: process.env.NODE_ENV });
});

app.use('/api/auth', authRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/admin', userRoutes); 
app.use('/api/admin/lotteries', lotteryRoutes); 
app.use('/api/admin/closures', closureRoutes); 
app.use('/api/reports', reportRoutes); // <-- NUEVA RUTA DE REPORTES

// Manejo de errores global
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(err.stack);
    res.status(500).json({ 
        status: 'error', 
        message: 'Something went wrong!',
        detail: err.message 
    });
});

// Inicializa el servidor y la conexión a la DB
async function startServer() {
    try {
        await prisma.$connect();
        console.log('✅ Connected to PostgreSQL (Supabase) successfully.');
        app.listen(PORT, () => {
            console.log(`⚡️ Server is running on port ${PORT}`);
        });
    } catch (e) {
        console.error('❌ Failed to connect to database or start server:', e);
        process.exit(1);
    }
}

startServer();
