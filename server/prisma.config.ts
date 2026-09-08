import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'db/prisma/schema.prisma',
  migrations: {
    path: 'db/prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
