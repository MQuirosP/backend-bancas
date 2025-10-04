import { Decimal } from '@prisma/client/runtime/library';

/**
 * Convierte cualquier valor (string | number | Decimal) a instancia Decimal segura.
 */
export const toDecimal = (value: string | number | Decimal): Decimal => {
  if (value instanceof Decimal) return value;
  return new Decimal(value.toString());
};

/**
 * Suma múltiples valores numéricos garantizando precisión decimal.
 */
export const sumDecimals = (values: (string | number | Decimal)[]): Decimal => {
  return values.reduce<Decimal>(
    (acc, val) => acc.plus(toDecimal(val)),
    new Decimal(0)
  );
};

/**
 * Multiplica dos valores con precisión decimal.
 */
export const multiplyDecimals = (
  a: string | number | Decimal,
  b: string | number | Decimal
): Decimal => {
  return toDecimal(a).times(toDecimal(b));
};

/**
 * Resta valores con precisión decimal.
 */
export const subtractDecimals = (
  a: string | number | Decimal,
  b: string | number | Decimal
): Decimal => {
  return toDecimal(a).minus(toDecimal(b));
};

/**
 * Divide valores con precisión decimal.
 */
export const divideDecimals = (
  a: string | number | Decimal,
  b: string | number | Decimal
): Decimal => {
  return toDecimal(a).div(toDecimal(b));
};
