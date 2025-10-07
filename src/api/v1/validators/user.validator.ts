import { z } from "zod";

// ------------------------------------------------------
// CREATE
// ------------------------------------------------------
export const createUserSchema = z
  .object({
    name: z.string().min(2, "Name is too short"),
    email: z.string().email("Invalid email"),
    password: z.string().min(6, "Password must be at least 6 characters"),
    role: z.enum(["ADMIN", "VENTANA", "VENDEDOR"]),
    ventanaId: z.string().uuid("Invalid ventanaId").optional(),
  })
  .refine(
    (data) => data.role === "ADMIN" || !!data.ventanaId,
    {
      message: "ventanaId is required unless role is ADMIN",
      path: ["ventanaId"],
    }
  );

// ------------------------------------------------------
// UPDATE
// ------------------------------------------------------
export const updateUserSchema = z.object({
  name: z.string().min(2, "Name is too short").optional(),
  email: z.string().email("Invalid email").optional(),
  password: z.string().min(6, "Password must be at least 6 characters").optional(),
  role: z.enum(["ADMIN", "VENTANA", "VENDEDOR"]).optional(),
  ventanaId: z.string().uuid("Invalid ventanaId").nullable().optional(),
});

// ------------------------------------------------------
// LIST QUERY
// ------------------------------------------------------
export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).optional(),
  role: z.enum(["ADMIN", "VENTANA", "VENDEDOR"]).optional(),
  isDeleted: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .optional(),
});
