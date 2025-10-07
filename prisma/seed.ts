import { hashPassword } from './../src/utils/crypto';
import prisma from '../src/core/prismaClient';

async function main() {
  const adminEmail = 'admin@system.local';
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (!existing) {
    const hashed = await hashPassword('admin123');
    await prisma.user.create({
      data: {
        name: 'System Admin',
        email: adminEmail,
        password: hashed,
        role: 'ADMIN',
      },
    });
    console.log('✅ Admin user created:', adminEmail);
  } else {
    console.log('ℹ️ Admin user already exists');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect();
  });
