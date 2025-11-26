import bcrypt from "bcryptjs";

export const hashPassword = (plain: string) => bcrypt.hash(plain, 8);
export const comparePassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);
