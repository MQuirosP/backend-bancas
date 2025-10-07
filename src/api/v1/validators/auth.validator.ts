import { z } from "zod";

export const registerSchema = z.object({
    name: z.string().min(2, "Name is too short").max(100, "Name is too long"),
    email: z.email("Invalid email address"),
    password: z.string().min(6, 'Password must be at least 6 characters long').max(100, 'Password must be at most 100 characters long'),
    role: z.enum(['ADMIN', 'VENTANA', 'VENDEDOR']).optional(),
    ventanaId: z.uuid(),
});

export const loginSchema = z.object({
    email: z.email("Invalid email address"),
    password: z.string().min(6, 'Password must be at least 6 characters long').max(100, 'Password must be at most 100 characters long'),
});
