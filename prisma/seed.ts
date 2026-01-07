import { hashPassword } from '../src/utils/crypto';
import prisma from '../src/core/prismaClient';

async function main() {
  const adminEmail = 'admin@system.local';
  const username = 'admin.sys.root';
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (!existing) {
    const hashed = await hashPassword('admin123');
    await prisma.user.create({
      data: {
        name: 'System Admin',
        email: adminEmail,
        username: username,
        password: hashed,
        role: 'ADMIN',
      },
    });
    console.log(' Admin user created:', adminEmail);
  } else {
    console.log('️ Admin user already exists');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect();
  });
