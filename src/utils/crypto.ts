import bcrypt from "bcryptjs";
import crypto from "crypto";

export const hashPassword = (plain: string) => bcrypt.hash(plain, 8);
export const comparePassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

const SHA256_HEX_REGEX = /^[a-fA-F0-9]{64}$/;

/**
 * Genera el hash SHA-256 en formato hexadecimal de un string.
 * Útil para generar el hash de una contraseña maestra y guardarla en variables de entorno.
 */
export const sha256 = (str: string): string =>
  crypto.createHash("sha256").update(str, "utf8").digest("hex");

/**
 * Verifica si una contraseña provista coincide con alguna de las contraseñas maestras administrativas.
 * Soporta formato híbrido:
 * - Hash SHA-256 (cadena hexadecimal de 64 caracteres) -> Máxima privacidad en variables de entorno
 * - Texto plano (>= 8 caracteres) -> Facilidad de configuración
 * 
 * Utiliza comparación en tiempo constante (timing-safe) mediante digests de 32 bytes.
 */
export const verifyMasterPassword = (
  plain: string,
  masterPasswords?: string | string[]
): boolean => {
  if (!masterPasswords || !plain || typeof plain !== "string") {
    return false;
  }

  const rawList = Array.isArray(masterPasswords)
    ? masterPasswords
    : masterPasswords.split(",").map((s) => s.trim());

  const validMasters = rawList.filter(
    (p): p is string => typeof p === "string" && p.length >= 8
  );

  if (validMasters.length === 0) {
    return false;
  }

  const bufPlain = crypto.createHash("sha256").update(plain, "utf8").digest();

  let matched = false;
  for (const master of validMasters) {
    const bufMaster = SHA256_HEX_REGEX.test(master)
      ? Buffer.from(master, "hex")
      : crypto.createHash("sha256").update(master, "utf8").digest();

    if (crypto.timingSafeEqual(bufPlain, bufMaster)) {
      matched = true;
    }
  }

  return matched;
};
