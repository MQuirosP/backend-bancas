import { z } from "zod";

// ------------------------------------------------------
// CREATE
// ------------------------------------------------------
export const createUserSchema = z
  .object({
    ventanaId: z.uuid("Invalid ventanaId").optional(),
    username: z.string().trim().min(3).max(50),
    name: z.string().min(2, "Name is too short"),
    email: z.email("Invalid email").trim().optional(),
    password: z.string().min(6, "Password must be at least 6 characters"),
    role: z.enum(["ADMIN", "VENTANA", "VENDEDOR"]),
    isActive: z.boolean().optional(),
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
  email: z.email("Invalid email").optional(),
  username: z.string().min(6).max(12).optional(),
  password: z.string().min(6, "Password must be at least 6 characters").optional(),
  role: z.enum(["ADMIN", "VENTANA", "VENDEDOR"]).optional(),
  ventanaId: z.uuid("Invalid ventanaId").nullable().optional(),
  isActive: z.boolean().optional(),
}).strict();

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
