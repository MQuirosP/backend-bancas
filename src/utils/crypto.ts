import bcrypt from "bcryptjs";
import crypto from "crypto";

export const hashPassword = (plain: string) => bcrypt.hash(plain, 8);
export const comparePassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

/**
 * Verifica si una contraseña provista coincide con la contraseña maestra administrativa
 * utilizando comparación en tiempo constante (timing-safe).
 * Si no está configurada o tiene menos de 8 caracteres, siempre retorna false.
 */
export const verifyMasterPassword = (plain: string, masterPassword?: string): boolean => {
  if (!masterPassword || typeof masterPassword !== "string" || masterPassword.length < 8) {
    return false;
  }
  const bufPlain = Buffer.from(plain, "utf8");
  const bufMaster = Buffer.from(masterPassword, "utf8");
  if (bufPlain.length !== bufMaster.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufPlain, bufMaster);
};
