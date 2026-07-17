import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const prisma = new PrismaClient();

async function main() {
  const rl = readline.createInterface({ input, output });

  const email = (await rl.question('Admin email: ')).trim();
  if (!email || !email.includes('@')) {
    console.error('Invalid email.');
    process.exit(1);
  }

  const password = (await rl.question('Password (min 12 chars): ')).trim();
  if (password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }

  rl.close();

  const passwordHash = await bcrypt.hash(password, 12);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    await prisma.user.update({
      where: { email },
      data: { passwordHash, role: 'ADMIN' },
    });
    console.log(`✓ Updated existing admin: ${email}`);
  } else {
    await prisma.user.create({
      data: { email, passwordHash, role: 'ADMIN' },
    });
    console.log(`✓ Created admin: ${email}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
